/**
 * Read-side ownership: an unattributable session must not inherit main's
 * reflection content.
 *
 * Hook identity used to fall back to "main" whenever ctx.agentId was absent and
 * the session key could not be parsed. That synthesized identity passes agent-id
 * validation, because main is a declared agent, so both reflection
 * before_prompt_build hooks resolved main's scopes and loaded main's private
 * invariant and derived slices into a session that owns none of it.
 *
 * These run the REGISTERED production hooks, not a logic mirror.
 *
 * Fixtures are synthetic.
 */

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

const embedderModuleForMock = jiti("../src/embedder.js");
embedderModuleForMock.createEmbedder = () => ({
  async embedPassage() { return [0.5, 0.5, 0.5, 0.5]; },
  async embedQuery() { return [0.5, 0.5, 0.5, 0.5]; },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { MemoryStore } = jiti("../src/store.ts");
const { storeReflectionToLanceDB } = jiti("../src/reflection-store.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = [0.5, 0.5, 0.5, 0.5];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAIN_INVARIANT = "Always keep the synthetic ledger key beside the main agent's notes.";
const MAIN_DERIVED = "Next run re-check the synthetic ledger for the main agent.";

async function seedMainReflection(dbPath) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  await storeReflectionToLanceDB({
    reflectionText: [
      "## Invariants",
      `- ${MAIN_INVARIANT}`,
      "## Derived",
      `- ${MAIN_DERIVED}`,
    ].join("\n"),
    sessionKey: "agent:main:session:test",
    sessionId: "session-main",
    agentId: "main",
    command: "command:new",
    scope: "agent:main",
    toolErrorSignals: [],
    runAt: Date.now() - 2 * DAY_MS,
    usedFallback: false,
    embedPassage: async () => FIXED_VECTOR,
    vectorSearch: async () => [],
    store: async (entry) => store.store(entry),
  });
}

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

function makePluginConfig(workDir, injectMode) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: {
      apiKey: "test-api-key",
      dimensions: EMBEDDING_DIMENSIONS,
    },
    sessionStrategy: "memoryReflection",
    memoryReflection: { injectMode },
    smartExtraction: false,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
  };
}

function getReflectionHooks(eventHandlers) {
  const hooks = eventHandlers.get("before_prompt_build") || [];
  const inheritedRules = hooks.find(({ meta }) => meta?.priority === 12)?.handler;
  const derivedFocus = hooks.find(({ meta }) => meta?.priority === 15)?.handler;
  assert.equal(typeof inheritedRules, "function", "expected the inherited-rules before_prompt_build hook");
  assert.equal(typeof derivedFocus, "function", "expected the derived-focus before_prompt_build hook");
  return { inheritedRules, derivedFocus };
}

// Session shapes that cannot be attributed to an agent: no ctx.agentId, and a
// session key that either is absent/empty or does not carry an agent segment.
const UNATTRIBUTABLE_CONTEXTS = [
  { label: "absent session key", ctx: {} },
  { label: "empty session key", ctx: { sessionKey: "" } },
  { label: "whitespace session key", ctx: { sessionKey: "   " } },
  { label: "malformed session key", ctx: { sessionKey: "channel:example:998877" } },
  { label: "agent-prefixed but empty id", ctx: { sessionKey: "agent::session:zz" } },
  { label: "blank explicit agentId", ctx: { sessionKey: "channel:example:998877", agentId: "   " } },
];

describe("reflection injection refuses an unattributable session", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "reflection-unattributed-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  for (const injectMode of ["inheritance-only", "inheritance+derived"]) {
    it(`serves main's reflection to an attributed main session (sanity, injectMode=${injectMode})`, async () => {
      const pluginConfig = makePluginConfig(workDir, injectMode);
      await seedMainReflection(pluginConfig.dbPath);

      const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
      memoryLanceDBProPlugin.register(harness.api);
      const { inheritedRules } = getReflectionHooks(harness.eventHandlers);

      const served = await inheritedRules({}, { sessionKey: "agent:main:test", agentId: "main" });
      assert.match(
        served?.prependContext ?? "",
        new RegExp(MAIN_INVARIANT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "sanity: main's own session must still receive main's invariant, otherwise the leak tests prove nothing",
      );
    });

    for (const { label, ctx } of UNATTRIBUTABLE_CONTEXTS) {
      it(`loads and prepends nothing for a ${label} (injectMode=${injectMode})`, async () => {
        const pluginConfig = makePluginConfig(workDir, injectMode);
        await seedMainReflection(pluginConfig.dbPath);

        const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
        memoryLanceDBProPlugin.register(harness.api);
        const { inheritedRules, derivedFocus } = getReflectionHooks(harness.eventHandlers);

        for (const [hookName, hook] of [
          ["inherited-rules", inheritedRules],
          ["derived-focus", derivedFocus],
        ]) {
          const result = await hook({}, { ...ctx });
          const prepended = result?.prependContext ?? "";
          assert.equal(
            prepended,
            "",
            `${hookName} must prepend nothing for an unattributable session, got: ${JSON.stringify(prepended.slice(0, 160))}`,
          );
          assert.ok(
            !prepended.includes(MAIN_INVARIANT) && !prepended.includes(MAIN_DERIVED),
            `${hookName} must not serve main's private reflection content`,
          );
        }

        assert.ok(
          !harness.logs.some(([, message]) => message.includes("'main'")),
          "no hook may resolve the session to a synthesized main identity",
        );
      });
    }
  }
});
