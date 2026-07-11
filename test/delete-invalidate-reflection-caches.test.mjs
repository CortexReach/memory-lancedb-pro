import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";
import { Command } from "commander";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

// The plugin's internal reflection-generation path embeds text with the real embedder
// built from config.embedding; without a mock it tries to hit OpenAI with a fake api key.
// (A Float32Array here would silently fail MemoryStore.bulkStore()'s Array.isArray()
// validity filter, so this returns plain arrays.)
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

async function seedReflection(dbPath, agentId, scope) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  await storeReflectionToLanceDB({
    reflectionText: [
      "## Invariants",
      `- Always verify reflection hook coverage for ${agentId}.`,
      "## Derived",
      `- Next run exercise the reflection injection path for ${agentId}.`,
    ].join("\n"),
    sessionKey: `agent:${agentId}:session:test`,
    sessionId: `session-${agentId}`,
    agentId,
    command: "command:new",
    scope,
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
  const cliFactories = [];

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
    registerCli(cliFactory) {
      cliFactories.push(cliFactory);
    },
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

  return { api, eventHandlers, logs, cliFactories };
}

function makePluginConfig(workDir) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: {
      apiKey: "test-api-key",
      dimensions: EMBEDDING_DIMENSIONS,
    },
    sessionStrategy: "memoryReflection",
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
  assert.equal(typeof inheritedRules, "function", "expected inherited-rules before_prompt_build hook");
  assert.equal(typeof derivedFocus, "function", "expected derived-focus before_prompt_build hook");
  return { inheritedRules, derivedFocus };
}

async function runCliDeleteBulk(cliFactories, scope) {
  assert.equal(cliFactories.length, 1, "expected exactly one registered CLI factory");
  const program = new Command();
  program.exitOverride();
  cliFactories[0]({ program });
  await program.parseAsync([
    "node", "openclaw", "memory-pro", "delete-bulk", "--scope", scope,
  ]);
}

describe("delete/delete-bulk synchronously invalidate in-process reflection caches", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "delete-invalidate-reflection-"));
    resetRegistration();
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reflectionByAgentCache: an immediate post-delete inherited-rules read no longer serves the deleted invariant", async () => {
    const pluginConfig = makePluginConfig(workDir);
    await seedReflection(pluginConfig.dbPath, "dave", "global");

    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const { inheritedRules } = getReflectionHooks(harness.eventHandlers);
    const ctx = { sessionKey: "agent:dave:test", agentId: "dave" };

    // Prime reflectionByAgentCache with the seeded invariant.
    const primed = await inheritedRules({}, ctx);
    assert.match(primed?.prependContext ?? "", /<inherited-rules>/, "sanity: cache should be primed with the seeded invariant");
    assert.match(primed?.prependContext ?? "", /Always verify reflection hook coverage for dave\./);

    // Delete the underlying row through the plugin's own in-process CLI delete-bulk path.
    await runCliDeleteBulk(harness.cliFactories, "global");

    // Immediately re-read through the same injection path (well within the old 15s TTL window).
    const afterDelete = await inheritedRules({}, ctx);
    assert.equal(
      afterDelete,
      undefined,
      "the inherited-rules hook must not keep serving the deleted invariant from a stale cache entry",
    );
  });

  it("reflectionByAgentCache: an unrelated scope's cache entry is left untouched by the delete", async () => {
    const pluginConfig = makePluginConfig(workDir);
    await seedReflection(pluginConfig.dbPath, "dave", "global");
    await seedReflection(pluginConfig.dbPath, "carol", "global");

    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const { inheritedRules } = getReflectionHooks(harness.eventHandlers);

    // Prime both agents' cache entries.
    await inheritedRules({}, { sessionKey: "agent:dave:test", agentId: "dave" });
    await inheritedRules({}, { sessionKey: "agent:carol:test", agentId: "carol" });

    // Delete from a scope neither agent's reflections live in.
    await runCliDeleteBulk(harness.cliFactories, "unrelated-scope");

    const carolAfter = await inheritedRules({}, { sessionKey: "agent:carol:test", agentId: "carol" });
    assert.match(
      carolAfter?.prependContext ?? "",
      /Always verify reflection hook coverage for carol\./,
      "an unaffected agent's cached invariant should still be served without a fresh DB round trip",
    );
  });

  it("reflectionDerivedBySession: an immediate post-delete derived-focus read no longer serves the deleted derived line", async () => {
    const pluginConfig = { ...makePluginConfig(workDir), memoryReflection: { timeoutMs: 5000 } };

    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    // A successful embedded completion with real (non-placeholder) invariant/derived
    // content. The fallback path's placeholder text is deliberately filtered out by
    // isPlaceholderReflectionSliceLine() before it ever reaches reflectionDerivedBySession,
    // so a genuine successful run is needed to actually populate the cache under test.
    harness.api.runtime = {
      agent: {
        async runEmbeddedPiAgent() {
          return {
            payloads: [{
              text: [
                "## Invariants",
                "- Always double-check branch names before pushing.",
                "## Derived",
                "- Prefer the shorter branch naming convention next run.",
              ].join("\n"),
            }],
          };
        },
      },
    };
    memoryLanceDBProPlugin.register(harness.api);

    const sessionFile = path.join(workDir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "Please remember this cache test." } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on it." } }),
      ].join("\n"),
      "utf-8",
    );

    const commandHooks = harness.eventHandlers.get("command:new") || [];
    const reflectionCommandHook = commandHooks.find((hook) =>
      hook.meta?.name === "memory-lancedb-pro.memory-reflection.command-new"
    );
    assert.ok(reflectionCommandHook, "expected memory reflection command:new hook");

    const sessionKey = "agent:main:cache-invalidation-test";
    // action: "tick" (not "new"/"reset") so this is treated as a non-boundary reflection
    // event: reflectionDerivedBySession.set() only runs for non-boundary actions (a fresh
    // /new intentionally suppresses derived-focus injection on the immediately following
    // prompt), and this test needs the cache actually populated to prove it gets invalidated.
    await reflectionCommandHook.handler({
      sessionKey,
      timestamp: 1_800_000_000_000,
      action: "tick",
      context: {
        cfg: pluginConfig,
        workspaceDir: workDir,
        sessionEntry: {
          sessionId: "cache-invalidation-session",
          sessionFile,
        },
      },
    }, { sessionKey, agentId: "main" });

    const { derivedFocus } = getReflectionHooks(harness.eventHandlers);
    const ctx = { sessionKey, agentId: "main" };

    const primed = await derivedFocus({}, ctx);
    assert.match(
      primed?.prependContext ?? "",
      /Prefer the shorter branch naming convention next run\./,
      "sanity: reflectionDerivedBySession should be primed by the just-generated reflection",
    );

    // Find the scope the reflection was actually persisted under, then delete it through
    // the plugin's own in-process CLI delete-bulk path.
    const store = new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const stored = await store.list(undefined, "reflection", 50, 0);
    const ownRow = stored.find((entry) => {
      try {
        return JSON.parse(entry.metadata).agentId === "main";
      } catch {
        return false;
      }
    });
    assert.ok(ownRow, "expected the generated reflection to have been persisted");

    await runCliDeleteBulk(harness.cliFactories, ownRow.scope);

    const afterDelete = await derivedFocus({}, ctx);
    assert.doesNotMatch(
      afterDelete?.prependContext ?? "",
      /Prefer the shorter branch naming convention next run\./,
      "the derived-focus hook must not keep serving the deleted derived line from reflectionDerivedBySession",
    );
  });
});

// The CLI delete/delete-bulk commands run as a short-lived, separate process from the
// long-running Gateway in typical deployments, so onMemoriesDeleted firing there (as
// exercised above) does not reach this process's caches. These tests simulate that
// genuinely cross-process case directly: the underlying row is deleted through a
// second, unrelated MemoryStore instance that never goes through this harness's CLI
// wiring at all, proving the bounded TTL added to both caches' read paths -- not the
// CLI invalidation callback -- is what actually bounds staleness for that scenario.
describe("cross-process deletes are bounded by cache TTL, not by the same-process invalidation callback", () => {
  let workDir;
  let realDateNow;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "delete-invalidate-reflection-ttl-"));
    resetRegistration();
    realDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = realDateNow;
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reflectionByAgentCache: still serves stale content immediately after a cross-process delete, but not once the TTL has elapsed", async () => {
    const pluginConfig = makePluginConfig(workDir);
    await seedReflection(pluginConfig.dbPath, "dave", "global");

    const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);
    const { inheritedRules } = getReflectionHooks(harness.eventHandlers);
    const ctx = { sessionKey: "agent:dave:test", agentId: "dave" };

    const primed = await inheritedRules({}, ctx);
    assert.match(primed?.prependContext ?? "", /Always verify reflection hook coverage for dave\./, "sanity: cache primed");

    // Delete through a second, independent store instance -- this harness's
    // onMemoriesDeleted callback never fires, matching a genuine cross-process delete.
    const otherProcessStore = new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    await otherProcessStore.bulkDelete(["global"], Date.now() + 1);

    const immediatelyAfter = await inheritedRules({}, ctx);
    assert.match(
      immediatelyAfter?.prependContext ?? "",
      /Always verify reflection hook coverage for dave\./,
      "expected boundary: within the TTL window, an out-of-band delete this process was never told about is still served from cache",
    );

    Date.now = () => realDateNow() + 16_000; // past DEFAULT_REFLECTION_CACHE_TTL_MS (15s)
    const afterTtl = await inheritedRules({}, ctx);
    assert.equal(
      afterTtl,
      undefined,
      "once the TTL has elapsed the cache must be treated as stale and recomputed, reflecting the cross-process delete",
    );
  });
});
