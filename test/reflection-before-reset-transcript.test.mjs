/**
 * reflection-before-reset-transcript.test.mjs
 *
 * On hosts with SQLite session storage the command:new hook can arrive with no
 * transcript at all (the Gateway command path emits it before it captures one),
 * while the typed before_reset hook, fired right after it on every path,
 * carries the departing messages. The reflection parks on the command hook and
 * finishes from the before_reset messages; it must never run twice for one
 * boundary and must ignore before_reset events that belong to no parked hook.
 * Fixtures are synthetic.
 *
 * Run: node --test test/reflection-before-reset-transcript.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { AsyncLocalStorage } from "node:async_hooks";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
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
      return path.isAbsolute(target) ? target : path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.push(String(message)); },
      warn(message) { logs.push(String(message)); },
      debug(message) { logs.push(String(message)); },
      error(message) { logs.push(String(message)); },
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

const DEPARTING_MESSAGES = [
  { role: "user", content: "Please remember that the rehearsal moved to Thursday." },
  { role: "assistant", content: "Noted, the rehearsal is on Thursday now." },
  { role: "user", content: "And the venue stays the same, the old town hall." },
];

const HOOK_TRANSCRIPT = [
  'user: "Please remember that the rehearsal moved to Thursday."',
  'assistant: "Noted, the rehearsal is on Thursday now."',
].join("\n");

describe("reflection finishes from the typed before_reset messages", () => {
  let workDir;
  let originalCliBin;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflect-before-reset-"));
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

  function registered() {
    const pluginConfig = makePluginConfig(workDir);
    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const commandHooks = harness.eventHandlers.get("command:new") || [];
    const beforeResetHooks = harness.eventHandlers.get("before_reset") || [];
    assert.equal(commandHooks.length, 1, "one command:new reflection hook");
    assert.equal(beforeResetHooks.length, 1, "exactly one before_reset listener under the memoryReflection strategy");
    return { harness, pluginConfig, commandHook: commandHooks[0].handler, beforeResetHook: beforeResetHooks[0].handler };
  }

  async function fireCommandNew({ commandHook, pluginConfig }, sessionId, extraContext = {}) {
    const sessionKey = `agent:main:session:${sessionId}`;
    await commandHook(
      {
        sessionKey,
        timestamp: 1000,
        action: "command:new",
        context: { cfg: pluginConfig, workspaceDir: workDir, previousSessionEntry: { sessionId }, ...extraContext },
      },
      { sessionKey, agentId: "main" },
    );
    return sessionKey;
  }

  async function fireBeforeReset({ beforeResetHook }, sessionKey, sessionId, { reason = "new", messages = DEPARTING_MESSAGES } = {}) {
    await beforeResetHook(
      { sessionFile: `sqlite:${sessionId}`, messages, reason },
      { agentId: "main", sessionKey, sessionId, workspaceDir: workDir },
    );
  }

  it("parks on a command hook without any transcript and reflects from the before_reset messages", async () => {
    const setup = registered();
    const sessionKey = await fireCommandNew(setup, "parked");
    const { logs } = setup.harness;
    assert.ok(
      logs.some((m) => m.includes("no transcript in the hook context or on disk for session parked; waiting for the typed before_reset messages")),
      `got ${JSON.stringify(logs)}`,
    );
    assert.ok(!logs.some((m) => m.includes("missing session file after recovery")), "no legacy missing-file warning");
    assert.ok(!logs.some((m) => m.includes("empty/unusable guard recorded")), "parking is not an empty session");
    assert.ok(!logs.some((m) => m.includes("reflection generation start")), "nothing ran yet");

    await fireBeforeReset(setup, sessionKey, "parked");
    assert.ok(
      logs.some((m) => m.includes("using the before_reset transcript for session parked; messages=present")),
      `got ${JSON.stringify(logs)}`,
    );
    assert.equal(
      logs.filter((m) => m.includes("reflection generation start for session parked")).length,
      1,
      `the parked boundary reflects exactly once: ${JSON.stringify(logs)}`,
    );
  });

  it("ignores a before_reset event that belongs to no parked command hook", async () => {
    const setup = registered();
    await fireBeforeReset(setup, "agent:main:session:orphan", "orphan");
    const { logs } = setup.harness;
    assert.ok(!logs.some((m) => m.includes("using the before_reset transcript")), JSON.stringify(logs));
    assert.ok(!logs.some((m) => m.includes("reflection generation start")), JSON.stringify(logs));
  });

  it("does not reflect twice when the command hook already carried the transcript", async () => {
    const setup = registered();
    const sessionKey = await fireCommandNew(setup, "carried", {
      previousSessionMemory: { status: "available", content: HOOK_TRANSCRIPT, originClass: "agent" },
    });
    const { logs } = setup.harness;
    assert.ok(logs.some((m) => m.includes("using the hook-provided transcript for session carried")), JSON.stringify(logs));
    await fireBeforeReset(setup, sessionKey, "carried");
    assert.equal(logs.filter((m) => m.includes("reflection generation start for session carried")).length, 1, JSON.stringify(logs));
    assert.ok(!logs.some((m) => m.includes("using the before_reset transcript")), "the continuation must not run");
  });

  it("records the empty guard when the before_reset messages are empty", async () => {
    const setup = registered();
    const sessionKey = await fireCommandNew(setup, "empty");
    await fireBeforeReset(setup, sessionKey, "empty", { messages: [] });
    const { logs } = setup.harness;
    assert.ok(logs.some((m) => m.includes("using the before_reset transcript for session empty; messages=empty")), JSON.stringify(logs));
    assert.ok(logs.some((m) => m.includes("conversation empty/unusable for session empty")), JSON.stringify(logs));
    assert.ok(logs.some((m) => m.includes("empty/unusable guard recorded")), JSON.stringify(logs));
    assert.ok(!logs.some((m) => m.includes("reflection generation start")), "nothing to reflect on");
  });

  it("leaves a parked hook alone for before_reset reasons that are not a session boundary", async () => {
    const setup = registered();
    const sessionKey = await fireCommandNew(setup, "idle");
    await fireBeforeReset(setup, sessionKey, "idle", { reason: "idle" });
    const { logs } = setup.harness;
    assert.ok(!logs.some((m) => m.includes("using the before_reset transcript")), JSON.stringify(logs));
    await fireBeforeReset(setup, sessionKey, "idle");
    assert.ok(logs.some((m) => m.includes("using the before_reset transcript for session idle; messages=present")), "the boundary reason finishes it");
  });

  it("runs the continuation outside the command's async context so the embedded runner is admitted", async () => {
    // Core refuses embedded sub-runs enqueued from a released root-work context
    // (the /new command's), which is exactly where the fire-and-forget
    // before_reset hook runs. The continuation must not inherit that context.
    const callerContext = new AsyncLocalStorage();
    // The embedded-runner loader caches its result per module instance, and the
    // earlier cases ran without a runtime; load a fresh plugin module here.
    const freshModule = jitiFactory(import.meta.url, {
      interopDefault: true,
      moduleCache: false,
      alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
    })("../index.ts");
    const freshPlugin = freshModule.default || freshModule;
    const pluginConfig = makePluginConfig(workDir);
    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    let storeSeenByRunner = "not invoked";
    harness.api.runtime = {
      agent: {
        runEmbeddedAgent: async () => {
          storeSeenByRunner = callerContext.getStore();
          throw new Error("synthetic runner stop");
        },
      },
    };
    (freshModule.resetRegistration ?? (() => {}))();
    freshPlugin.register(harness.api);
    const setup = {
      harness,
      pluginConfig,
      commandHook: harness.eventHandlers.get("command:new")[0].handler,
      beforeResetHook: harness.eventHandlers.get("before_reset")[0].handler,
    };
    await callerContext.run({ released: true }, async () => {
      const sessionKey = await fireCommandNew(setup, "escaped");
      await fireBeforeReset(setup, sessionKey, "escaped");
    });
    assert.equal(storeSeenByRunner, undefined, "the embedded runner must not see the caller's released root context");
    assert.ok(harness.logs.some((m) => m.includes("reflection generation start for session escaped")), JSON.stringify(harness.logs));
  });

  it("parks when the recovered transcript file holds no usable conversation, then finishes from before_reset", async () => {
    const setup = registered();
    const staleFile = path.join(workDir, "stale-session.jsonl");
    writeFileSync(staleFile, JSON.stringify({ type: "session-meta", version: 1 }) + "\n", "utf-8");
    const sessionKey = await fireCommandNew(setup, "stalefile", { previousSessionEntry: { sessionId: "stalefile", sessionFile: staleFile } });
    const { logs } = setup.harness;
    assert.ok(
      logs.some((m) => m.includes("holds no usable conversation for session stalefile; waiting for the typed before_reset messages")),
      `got ${JSON.stringify(logs)}`,
    );
    assert.ok(!logs.some((m) => m.includes("empty/unusable guard recorded")), "a stale artifact must not record the empty guard");
    await fireBeforeReset(setup, sessionKey, "stalefile");
    assert.ok(logs.some((m) => m.includes("using the before_reset transcript for session stalefile; messages=present")), JSON.stringify(logs));
    assert.equal(logs.filter((m) => m.includes("reflection generation start for session stalefile")).length, 1, JSON.stringify(logs));
  });
});
