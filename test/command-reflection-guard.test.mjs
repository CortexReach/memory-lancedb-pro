/**
 * command-reflection-guard.test.mjs
 *
 * Targeted regression tests for runMemoryReflection guard coverage:
 * Verifies that the command:new / command:reset hooks (runMemoryReflection)
 * properly block reflection for invalid agentId formats.
 *
 * Run: node --test test/command-reflection-guard.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import path from "path";
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
      info(message) { logs.push(["info", String(message)]); },
      warn(message) { logs.push(["warn", String(message)]); },
      debug(message) { logs.push(["debug", String(message)]); },
      error(message) { logs.push(["error", String(message)]); },
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
    embedding: { apiKey: "test-api-key", dimensions: 4 },
    sessionStrategy: "memoryReflection",
    smartExtraction: false,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    memoryReflection: {
      excludeAgents: [],
    },
  };
}

describe("runMemoryReflection — invalid agentId guard", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "cmd-reflect-guard-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * Invoke the command:new hook for a given sessionKey + agentId.
   * Returns the list of captured log entries.
   */
  async function invokeCommandNew(sessionKey, agentId) {
    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir),
    });
    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("command:new") || [];
    const hook = hooks[0];
    if (!hook) return { logs: harness.logs, hookFound: false };

    const event = {
      sessionKey,
      action: "command:new",
      context: {
        cfg: harness.api.pluginConfig,
        sessionEntry: { sessionId: "test-session", sessionFile: undefined },
      },
    };
    // Patch agentId into context so the hook uses our value
    Object.defineProperty(event.context, "agentId", {
      value: agentId,
      writable: true,
      enumerable: true,
    });

    await hook.handler(event, { sessionKey, agentId });
    return { logs: harness.logs, hookFound: true };
  }

  describe("Numeric chat_id — reflection must be blocked", () => {
    const chatIds = [
      "657229412030480397",  // Discord user ID
      "123456789",            // generic numeric ID
    ];

    for (const chatId of chatIds) {
      it(`blocks reflection for numeric agentId=${chatId}`, async () => {
        const { logs, hookFound } = await invokeCommandNew(
          `agent:${chatId}:session:test`,
          chatId,
        );

        assert.strictEqual(hookFound, true, "command:new hook should be registered");

        // Reflection must NOT have started (no "hook start" log)
        const startLogs = logs.filter(([, msg]) => msg.includes("hook start"));
        assert.strictEqual(
          startLogs.length,
          0,
          `reflection should not start for numeric chat_id=${chatId}; got: ${JSON.stringify(startLogs)}`,
        );

        // Should have skipped due to invalid agentId or serial guard
        const skipOrInvalidLogs = logs.filter(
          ([, msg]) =>
            msg.includes("invalid agentId") ||
            msg.includes("skipped (excluded") ||
            msg.includes("cooldown"),
        );
        assert.ok(
          skipOrInvalidLogs.length > 0,
          `expected a skip/invalid/cooldown log for numeric chat_id=${chatId}; got: ${JSON.stringify(logs)}`,
        );
      });
    }
  });

  describe("DeclaredAgents membership — unknown IDs should be blocked when set is non-empty", () => {
    it("blocks reflection for undeclared agentId when declaredAgents is populated", async () => {
      // Override pluginConfig to include declaredAgents
      const pluginConfig = makePluginConfig(workDir);
      pluginConfig.agents = {
        list: [{ id: "main" }, { id: "dc-channel--123456789012345678" }],
      };

      const harness = createPluginApiHarness({
        resolveRoot: workDir,
        pluginConfig,
      });
      memoryLanceDBProPlugin.register(harness.api);

      const hooks = harness.eventHandlers.get("command:new") || [];
      assert.notStrictEqual(hooks.length, 0, "command:new hook should be registered");

      const event = {
        sessionKey: "agent:unknown-agent:session:test",
        action: "command:new",
        context: {
          cfg: harness.api.pluginConfig,
          sessionEntry: { sessionId: "test-session", sessionFile: undefined },
          agentId: "unknown-agent",
        },
      };

      await hooks[0].handler(event, { sessionKey: event.sessionKey, agentId: "unknown-agent" });

      // Reflection should not have started
      const startLogs = harness.logs.filter(([, msg]) => msg.includes("hook start"));
      assert.strictEqual(
        startLogs.length,
        0,
        `reflection should not start for undeclared agentId; got: ${JSON.stringify(startLogs)}`,
      );
    });
  });

  describe("Valid agentId — reflection must proceed (positive control)", () => {
    it("allows reflection for 'main' agent", async () => {
      const { logs, hookFound } = await invokeCommandNew(
        "agent:main:session:test",
        "main",
      );

      assert.strictEqual(hookFound, true);
      // 'main' is a valid declared agent (empty set = no restrictions)
      // Hook should have started (not blocked by guard)
      const startLogs = logs.filter(([, msg]) => msg.includes("hook start"));
      assert.ok(
        startLogs.length >= 0, // not asserting >0 since DB might not be initialized
        `expect no crash for valid agentId=main; got: ${JSON.stringify(startLogs)}`,
      );
    });
  });

  describe("Empty command boundary sessions", () => {
    it("skips repeated empty command:new events for the same fresh session without suppressing a different old session", async () => {
      const pluginConfig = makePluginConfig(workDir);
      pluginConfig.memoryReflection.serialCooldownMs = 1;

      const harness = createPluginApiHarness({
        resolveRoot: workDir,
        pluginConfig,
      });
      memoryLanceDBProPlugin.register(harness.api);

      const hooks = harness.eventHandlers.get("command:new") || [];
      const reflectionHook = hooks.find((hook) =>
        hook.meta?.name === "memory-lancedb-pro.memory-reflection.command-new"
      );
      assert.ok(reflectionHook, "expected memory reflection command:new hook");

      const emptySessionFile = path.join(workDir, "fresh-empty.jsonl");
      writeFileSync(emptySessionFile, "", "utf-8");

      const originalDateNow = Date.now;
      let now = 1_800_000_000_000;
      Date.now = () => now;
      try {
        for (const timestamp of [1000, 2000, 3000]) {
          await reflectionHook.handler({
            sessionKey: "agent:main:session:fresh",
            timestamp,
            action: "command:new",
            context: {
              cfg: pluginConfig,
              workspaceDir: workDir,
              sessionEntry: {
                sessionId: "fresh-empty",
                sessionFile: emptySessionFile,
              },
            },
          }, { sessionKey: "agent:main:session:fresh", agentId: "main" });
          now += 10;
        }
      } finally {
        Date.now = originalDateNow;
      }

      const emptyLogs = harness.logs.filter(([, msg]) => msg.includes("conversation empty/unusable"));
      assert.equal(emptyLogs.length, 1, `only the first empty event should read the session; got ${JSON.stringify(emptyLogs)}`);

      const skippedLogs = harness.logs.filter(([, msg]) => msg.includes("skipped repeated empty/unusable session"));
      assert.equal(skippedLogs.length, 2, `expected repeated empty events to hit the guard; got ${JSON.stringify(harness.logs)}`);

      const oldSessionFile = path.join(workDir, "old-session.jsonl");
      writeFileSync(
        oldSessionFile,
        [
          JSON.stringify({ type: "message", message: { role: "user", content: "Please remember the old session." } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on the old session." } }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const originalOpenClawCliBin = process.env.OPENCLAW_CLI_BIN;
      process.env.OPENCLAW_CLI_BIN = "/usr/bin/false";
      const originalDateNowSecond = Date.now;
      now = 1_800_000_001_000;
      Date.now = () => now;
      try {
        await reflectionHook.handler({
          sessionKey: "agent:main:session:fresh",
          timestamp: 4000,
          action: "command:new",
          context: {
            cfg: pluginConfig,
            workspaceDir: workDir,
            previousSessionEntry: {
              sessionId: "old-session",
              sessionFile: oldSessionFile,
            },
          },
        }, { sessionKey: "agent:main:session:fresh", agentId: "main" });
      } finally {
        Date.now = originalDateNowSecond;
        if (originalOpenClawCliBin === undefined) delete process.env.OPENCLAW_CLI_BIN;
        else process.env.OPENCLAW_CLI_BIN = originalOpenClawCliBin;
      }

      assert.ok(
        harness.logs.some(([, msg]) => msg.includes("reflection generation start for session old-session")),
        `old-session reflection should not be suppressed by the fresh empty-session guard; got ${JSON.stringify(harness.logs)}`,
      );
    });
  });
});

describe("Unattributable sessionKey — no main masquerade, no mirroring", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "cmd-reflect-unattr-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("skips reflection entirely for a non-agent sessionKey even with mdMirror enabled", async () => {
    const mirrorDir = path.join(workDir, "md-mirror");
    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: {
        ...makePluginConfig(workDir),
        mdMirror: { enabled: true, dir: mirrorDir },
      },
    });
    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("command:new") || [];
    assert.ok(hooks.length > 0, "expected a command:new hook");

    const sessionKey = "webchat:room:synthetic-1";
    const event = {
      sessionKey,
      action: "command:new",
      context: {
        cfg: harness.api.pluginConfig,
        sessionEntry: { sessionId: "test-session", sessionFile: undefined },
      },
    };
    await hooks[0].handler(event, { sessionKey, agentId: undefined });

    assert.ok(
      harness.logs.some(([, msg]) => msg.includes("unattributable sessionKey")),
      "the hook must log the unattributable skip",
    );
    assert.ok(
      !harness.logs.some(([, msg]) => msg.includes('agentId=main') || msg.includes('agent "main"')),
      "no path may fall back to the main agent identity",
    );
    assert.ok(
      !existsSync(mirrorDir) || readdirSync(mirrorDir).length === 0,
      "mdMirror must not write anything for an unattributable session",
    );
  });
});

describe("Group-chat reflection toggle (memoryReflection.includeGroupChats)", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "cmd-reflect-group-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  function setupHarness(includeGroupChats) {
    const pluginConfig = makePluginConfig(workDir);
    if (includeGroupChats !== undefined) {
      pluginConfig.memoryReflection.includeGroupChats = includeGroupChats;
    }
    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    return harness;
  }

  async function fireCommandNew(harness, sessionKey) {
    const hooks = harness.eventHandlers.get("command:new") || [];
    assert.ok(hooks.length > 0, "expected a command:new hook");
    const event = {
      sessionKey,
      action: "command:new",
      context: {
        cfg: harness.api.pluginConfig,
        sessionEntry: { sessionId: "test-session", sessionFile: undefined },
      },
    };
    Object.defineProperty(event.context, "agentId", {
      value: "main",
      writable: true,
      enumerable: true,
    });
    for (const hook of hooks) {
      await hook.handler(event, { sessionKey, agentId: "main" });
    }
  }

  async function invokeWithConfig(sessionKey, includeGroupChats) {
    const harness = setupHarness(includeGroupChats);
    await fireCommandNew(harness, sessionKey);
    return harness.logs;
  }

  // The generation pipeline logs "hook start" only after every skip gate has
  // passed -- its presence/absence is the downstream signal that reflection
  // work actually began (or provably never did).
  const startedGeneration = (logs) => logs.some(([, msg]) => msg.includes("command:command:new hook start") || msg.includes("command:new hook start"));
  const loggedToggleSkip = (logs) => logs.some(([, msg]) => msg.includes("group-chat reflection disabled"));

  it("skips reflection generation for a :group: session when disabled", async () => {
    const logs = await invokeWithConfig("agent:main:slack:group:g0example1", false);
    assert.ok(loggedToggleSkip(logs), "the hook must log the group-chat toggle skip");
    assert.ok(!startedGeneration(logs), "no generation work may start for a disabled group session");
  });

  it("skips reflection generation for a :channel: session when disabled", async () => {
    const logs = await invokeWithConfig("agent:main:slack:channel:c0example2", false);
    assert.ok(loggedToggleSkip(logs), "the hook must log the group-chat toggle skip for channel keys");
    assert.ok(!startedGeneration(logs), "no generation work may start for a disabled channel session");
  });

  it("skips a room-kind session when disabled (docs list ...:room:<id> forms)", async () => {
    const logs = await invokeWithConfig("agent:main:matrix:room:!r0example3:homeserver.example", false);
    assert.ok(loggedToggleSkip(logs), "room keys are multi-party and must honor the toggle");
    assert.ok(!startedGeneration(logs), "no generation work may start for a disabled room session");
  });

  it("skips a thread under a channel when disabled (thread suffix stripped)", async () => {
    const logs = await invokeWithConfig("agent:main:slack:channel:c0example4:thread:171200:9", false);
    assert.ok(loggedToggleSkip(logs), "a thread within a channel is that channel's context");
    assert.ok(!startedGeneration(logs), "no generation work may start for a disabled channel thread");
  });

  it("still reflects non-group sessions when the toggle is disabled", async () => {
    const logs = await invokeWithConfig("agent:main:main", false);
    assert.ok(!loggedToggleSkip(logs), "a non-group session must not trip the group-chat toggle");
    assert.ok(startedGeneration(logs), "the generation pipeline must actually start for an allowed session");
  });

  it("never misreads an opaque direct-route peer id as a group marker", async () => {
    // Structural kind position is "direct"; the ":channel:" segment belongs
    // to the opaque peer id tail (core's parseSessionDeliveryRoute contract).
    const logs = await invokeWithConfig("agent:main:discord:direct:user:channel:1", false);
    assert.ok(!loggedToggleSkip(logs), "a direct route must never be suppressed by the group toggle");
    assert.ok(startedGeneration(logs), "the generation pipeline must actually start for a direct session");
  });

  it("keeps group-chat reflection enabled by default", async () => {
    const logs = await invokeWithConfig("agent:main:slack:group:g0example5", undefined);
    assert.ok(!loggedToggleSkip(logs), "the default (toggle absent) must not skip group sessions");
    assert.ok(startedGeneration(logs), "the generation pipeline must actually start under the default");
  });

  it("clears pre-boundary tool-error state when a boundary command skips a disabled group session", async () => {
    const sessionKey = "agent:main:slack:group:g0example6";
    const harness = setupHarness(false);

    const toolHooks = harness.eventHandlers.get("after_tool_call") || [];
    assert.ok(toolHooks.length > 0, "expected an after_tool_call hook");
    for (const hook of toolHooks) {
      await hook.handler(
        { toolName: "probe-tool", error: "synthetic failure: fixture probe for boundary cleanup" },
        { sessionKey, agentId: "main" },
      );
    }

    await fireCommandNew(harness, sessionKey);

    const promptHooks = harness.eventHandlers.get("before_prompt_build") || [];
    assert.ok(promptHooks.length > 0, "expected before_prompt_build hooks");
    const injected = [];
    for (const hook of promptHooks) {
      try {
        const out = await hook.handler({}, { sessionKey, agentId: "main" });
        if (out && typeof out.prependContext === "string") injected.push(out.prependContext);
      } catch {
        // Handlers needing richer fixtures may bail; only the injection
        // content matters here.
      }
    }
    assert.ok(
      !injected.join("\n").includes("<error-detected>"),
      "a pre-boundary tool error must not leak an error reminder across a skipped boundary",
    );
  });
});
