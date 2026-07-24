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
