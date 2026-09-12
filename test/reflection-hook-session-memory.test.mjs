/**
 * reflection-hook-session-memory.test.mjs
 *
 * Hosts with SQLite session storage no longer expose a transcript file to
 * plugins; the command:new / command:reset hook context carries the departing
 * session's recent messages as `previousSessionMemory` instead. Reflection must
 * run from that transcript first and keep the session-file lookup only as the
 * legacy fallback. Fixtures are synthetic.
 *
 * Run: node --test test/reflection-hook-session-memory.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import path from "path";
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
const { resolveReflectionSessionSearchDirs } = jiti("../src/session-recovery.ts");

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = [];
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      return path.isAbsolute(target) ? target : path.join(resolveRoot, target);
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
    memoryReflection: { excludeAgents: [] },
  };
}

const HOOK_TRANSCRIPT = [
  'user: "Please remember that the rehearsal moved to Thursday."',
  'assistant: "Noted, the rehearsal is on Thursday now."',
  'user: "And the venue stays the same, the old town hall."',
].join("\n");

describe("runMemoryReflection reads the transcript the hook already carries", () => {
  let workDir;
  let originalCliBin;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflect-hook-memory-"));
    resetRegistration();
    originalCliBin = process.env.OPENCLAW_CLI_BIN;
    process.env.OPENCLAW_CLI_BIN = "/usr/bin/false";
  });

  afterEach(() => {
    resetRegistration();
    if (originalCliBin === undefined) delete process.env.OPENCLAW_CLI_BIN;
    else process.env.OPENCLAW_CLI_BIN = originalCliBin;
    rmSync(workDir, { recursive: true, force: true });
  });

  async function invoke(context, sessionId) {
    const pluginConfig = makePluginConfig(workDir);
    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const hook = (harness.eventHandlers.get("command:new") || [])[0];
    assert.ok(hook, "the command:new reflection hook must be registered");
    const sessionKey = `agent:main:session:${sessionId}`;
    await hook.handler(
      { sessionKey, timestamp: 1000, action: "command:new", context: { cfg: pluginConfig, workspaceDir: workDir, ...context } },
      { sessionKey, agentId: "main" },
    );
    return harness.logs.map(([, message]) => message);
  }

  it("reflects from previousSessionMemory when the host exposes no session file", async () => {
    const logs = await invoke(
      {
        previousSessionEntry: { sessionId: "sqlite-session" },
        previousSessionMemory: { status: "available", content: HOOK_TRANSCRIPT, originClass: "agent" },
      },
      "sqlite-session",
    );
    assert.ok(
      logs.some((m) => m.includes("using the hook-provided transcript for session sqlite-session")),
      `expected the hook transcript to be used; got ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((m) => m.includes("reflection generation start for session sqlite-session")),
      `reflection must reach the generation step; got ${JSON.stringify(logs)}`,
    );
    assert.ok(!logs.some((m) => m.includes("missing session file after recovery")), "no file lookup failure may be logged");
    assert.ok(!logs.some((m) => m.includes("session recovery start")), "no file recovery may run when the hook carries the transcript");
  });

  it("still reads the session file when the hook carries no transcript", async () => {
    const sessionFile = path.join(workDir, "old-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "Please remember the old session." } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on the old session." } }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const logs = await invoke({ previousSessionEntry: { sessionId: "old-session", sessionFile } }, "old-session");
    assert.ok(logs.some((m) => m.includes("reflection generation start for session old-session")), `got ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((m) => m.includes("using the hook-provided transcript")), "the legacy file path must not claim a hook transcript");
  });

  it("falls back to the file lookup when the hook transcript is empty or unavailable", async () => {
    const logs = await invoke(
      {
        previousSessionEntry: { sessionId: "empty-hook" },
        previousSessionMemory: { status: "available", content: null, originClass: "agent" },
      },
      "empty-hook",
    );
    assert.ok(logs.some((m) => m.includes("missing session file after recovery for session empty-hook")), `got ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((m) => m.includes("reflection generation start")), "nothing to reflect on");

    const unavailable = await invoke(
      {
        previousSessionEntry: { sessionId: "unavailable-hook" },
        previousSessionMemory: { status: "unavailable", reason: "capture failed" },
      },
      "unavailable-hook",
    );
    assert.ok(unavailable.some((m) => m.includes("missing session file after recovery for session unavailable-hook")), `got ${JSON.stringify(unavailable)}`);
  });
});

describe("resolveReflectionSessionSearchDirs reads both agent config shapes", () => {
  it("enumerates agents.entries ids and workspaces like agents.list", () => {
    const entriesDirs = resolveReflectionSessionSearchDirs({
      context: {},
      cfg: { agents: { entries: { alpha: { workspace: "/srv/openclaw/workspace" }, beta: {} } } },
      workspaceDir: "/srv/openclaw/workspace-alpha",
      sourceAgentId: "alpha",
    });
    assert.ok(entriesDirs.includes("/srv/openclaw/agents/alpha/sessions"), JSON.stringify(entriesDirs));
    assert.ok(entriesDirs.includes("/srv/openclaw/agents/beta/sessions"), JSON.stringify(entriesDirs));

    const listDirs = resolveReflectionSessionSearchDirs({
      context: {},
      cfg: { agents: { list: [{ id: "gamma", workspace: "/srv/openclaw/workspace" }] } },
      workspaceDir: "/srv/openclaw/workspace-gamma",
      sourceAgentId: "gamma",
    });
    assert.ok(listDirs.includes("/srv/openclaw/agents/gamma/sessions"), JSON.stringify(listDirs));
  });
});
