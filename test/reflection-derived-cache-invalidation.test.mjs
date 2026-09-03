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
const jiti = jitiFactory(path.join(testDir, "reflection-derived-cache-invalidation.anchor.mjs"), {
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

// Deterministic seam for the same-process race test below: holds the window
// between storeReflectionToLanceDB resolving and the caller's next statement
// (the reflectionDerivedBySession cache write) open until the test releases
// it. A null gate is a plain passthrough, so the other tests are unaffected.
// Patched before the plugin module is imported, same idiom as the embedder
// mock above.
const reflectionStoreModule = jiti("../src/reflection-store.js");
const realStoreReflectionToLanceDB = reflectionStoreModule.storeReflectionToLanceDB;
let postStoreGate = null;
let notifyStoreResolved = null;
reflectionStoreModule.storeReflectionToLanceDB = async (...args) => {
  const result = await realStoreReflectionToLanceDB(...args);
  if (notifyStoreResolved) notifyStoreResolved();
  if (postStoreGate) await postStoreGate;
  return result;
};

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { MemoryStore } = jiti("../src/store.ts");

const EMBEDDING_DIMENSIONS = 4;

// The reflection slice parser drops short bullets, so fixture lines must stay
// sentence-length or the generation stores an event row with zero slices.
const INVARIANT_LINE = "Always confirm the derived cache invalidation contract for agent-one before merging.";
const DERIVED_LINE = "Next run exercise the derived cache invalidation handling path for agent-one in detail.";

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = [];
  const cliFactories = [];
  const toolFactories = [];
  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(m) { logs.push(["info", String(m)]); },
      warn(m) { logs.push(["warn", String(m)]); },
      debug(m) { logs.push(["debug", String(m)]); },
      error(m) { logs.push(["error", String(m)]); },
    },
    registerTool(toolFactory, meta) { toolFactories.push({ toolFactory, meta }); },
    registerCli(cliFactory) { cliFactories.push(cliFactory); },
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
  return { api, eventHandlers, logs, cliFactories, toolFactories };
}

function makePluginConfig(workDir) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: { apiKey: "test-api-key", dimensions: EMBEDDING_DIMENSIONS },
    sessionStrategy: "memoryReflection",
    memoryReflection: { timeoutMs: 5000 },
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

function makeHarnessWithGeneration(workDir) {
  const pluginConfig = makePluginConfig(workDir);
  const harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
  harness.api.runtime = {
    agent: {
      async runEmbeddedPiAgent() {
        return { payloads: [{ text: [
          "## Invariants",
          `- ${INVARIANT_LINE}`,
          "## Derived",
          `- ${DERIVED_LINE}`,
        ].join("\n") }] };
      },
    },
  };
  memoryLanceDBProPlugin.register(harness.api);
  return { pluginConfig, harness };
}

async function runReflectionGeneration(harness, pluginConfig, workDir, sessionKey, sessionId) {
  const sessionFile = path.join(workDir, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "message", message: { role: "user", content: "Please remember this cache invalidation scenario." } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: "I will reflect on it." } }),
  ].join("\n"), "utf-8");
  const commandHooks = harness.eventHandlers.get("command:new") || [];
  const reflectionCommandHook = commandHooks.find((h) => h.meta?.name === "memory-lancedb-pro.memory-reflection.command-new");
  assert.ok(reflectionCommandHook, "expected the command:new reflection hook");
  return reflectionCommandHook.handler({
    sessionKey, timestamp: 1_800_000_000_000, action: "tick",
    context: { cfg: pluginConfig, workspaceDir: workDir,
      sessionEntry: { sessionId, sessionFile } },
  }, { sessionKey, agentId: "agent-one" });
}

async function listReflectionRows(dbPath) {
  // Fresh MemoryStore per read: a reused handle can serve a stale table
  // version and hide rows written or deleted after it was opened.
  return new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS })
    .list(undefined, "reflection", 50, 0);
}

describe("reflectionDerivedBySession: cross-process delete is bounded by the cache TTL", () => {
  let workDir;
  let realDateNow;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "derived-cache-xproc-"));
    resetRegistration();
    realDateNow = Date.now;
  });
  afterEach(() => {
    Date.now = realDateNow;
    postStoreGate = null;
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("serves stale content within the TTL and recomputes past it, across an independent store instance", async () => {
    const { pluginConfig, harness } = makeHarnessWithGeneration(workDir);
    const sessionKey = "agent:agent-one:xproc-ttl";
    await runReflectionGeneration(harness, pluginConfig, workDir, sessionKey, "xproc-ttl-session");

    const { derivedFocus } = getReflectionHooks(harness.eventHandlers);
    const ctx = { sessionKey, agentId: "agent-one" };

    const primed = await derivedFocus({}, ctx);
    assert.match(primed?.prependContext ?? "", new RegExp(DERIVED_LINE), "sanity: derived cache primed by generation");

    // Delete through an independent store instance: this process's
    // invalidation callback never fires, matching a genuine cross-process delete.
    const rows = await listReflectionRows(pluginConfig.dbPath);
    assert.ok(rows.length > 0, "generation stored reflection rows");
    const otherProcessStore = new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    await otherProcessStore.bulkDelete([rows[0].scope], Date.now() + 1);
    assert.equal((await listReflectionRows(pluginConfig.dbPath)).length, 0, "cross-process delete removed the rows");

    const immediatelyAfter = await derivedFocus({}, ctx);
    assert.match(
      immediatelyAfter?.prependContext ?? "",
      new RegExp(DERIVED_LINE),
      "expected boundary: within the TTL window an out-of-band delete is still served from the session cache",
    );

    Date.now = () => realDateNow() + 16_000; // past DEFAULT_REFLECTION_CACHE_TTL_MS (15s)
    const afterTtl = await derivedFocus({}, ctx);
    assert.doesNotMatch(
      afterTtl?.prependContext ?? "",
      new RegExp(DERIVED_LINE),
      "once the TTL has elapsed the derived cache must be recomputed, reflecting the cross-process delete",
    );
  });

  it("keeps serving through the by-agent fallback until THAT cache's own TTL closes (two caches in series)", async () => {
    const { pluginConfig, harness } = makeHarnessWithGeneration(workDir);
    const sessionKey = "agent:agent-one:xproc-series";
    await runReflectionGeneration(harness, pluginConfig, workDir, sessionKey, "xproc-series-session");

    const { inheritedRules, derivedFocus } = getReflectionHooks(harness.eventHandlers);
    const ctx = { sessionKey, agentId: "agent-one" };

    // t0: derived session cache primed by the generation above.
    // t0+10s: a routine inherited-rules prompt build re-reads the DB (rows still
    // present) and primes the independently-clocked by-agent fallback cache.
    Date.now = () => realDateNow() + 10_000;
    const inherited = await inheritedRules({}, ctx);
    assert.match(inherited?.prependContext ?? "", new RegExp(INVARIANT_LINE), "sanity: fallback cache primed at t0+10s");

    // Cross-process delete lands after the fallback prime.
    const rows = await listReflectionRows(pluginConfig.dbPath);
    const otherProcessStore = new MemoryStore({ dbPath: pluginConfig.dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    await otherProcessStore.bulkDelete([rows[0].scope], Date.now() + 1);
    assert.equal((await listReflectionRows(pluginConfig.dbPath)).length, 0, "cross-process delete removed the rows");

    // t0+16s: the session cache is past its TTL, but the read does not go to
    // the DB; it falls back to the by-agent cache primed at t0+10s, so the
    // deleted line is still injected. This pins the real staleness bound:
    // one TTL from the LAST DB READ, not from the derived cache's priming.
    Date.now = () => realDateNow() + 16_000;
    const viaFallback = await derivedFocus({}, ctx);
    assert.match(
      viaFallback?.prependContext ?? "",
      new RegExp(DERIVED_LINE),
      "expected boundary: the stale derived cache falls back to the still-fresh by-agent cache",
    );

    // t0+26s: the fallback's own TTL (primed t0+10s) has elapsed; the next read
    // reaches the DB and the deleted content is gone.
    Date.now = () => realDateNow() + 26_000;
    const afterFallbackTtl = await derivedFocus({}, ctx);
    assert.doesNotMatch(
      afterFallbackTtl?.prependContext ?? "",
      new RegExp(DERIVED_LINE),
      "once the fallback cache's TTL has also elapsed the deleted content must stop being injected",
    );
  });
});

describe("reflectionDerivedBySession: same-process delete racing reflection generation", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "derived-cache-race-"));
    resetRegistration();
  });
  afterEach(() => {
    postStoreGate = null;
    notifyStoreResolved = null;
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("a delete landing between the reflection store and the cache write must not resurrect deleted derived lines", async () => {
    const { pluginConfig, harness } = makeHarnessWithGeneration(workDir);
    const sessionKey = "agent:agent-one:same-proc-race";

    let releaseGate;
    postStoreGate = new Promise((resolve) => { releaseGate = resolve; });
    const storeResolved = new Promise((resolve) => { notifyStoreResolved = resolve; });
    const handlerPromise = runReflectionGeneration(harness, pluginConfig, workDir, sessionKey, "race-session");

    // Deterministic ordering: the wrapper signals once storeReflectionToLanceDB
    // has fully resolved (every row written), then holds the gate so the caller
    // cannot reach its cache write until the test releases it.
    await storeResolved;
    notifyStoreResolved = null;
    const rows = await listReflectionRows(pluginConfig.dbPath);
    assert.ok(rows.length > 0, "generation stored reflection rows while the post-store gate held");

    // Same-process delete: fires invalidateReflectionCachesAfterDelete, which
    // bumps the generation counter and clears reflectionDerivedBySession.
    await runCliDeleteBulk(harness.cliFactories, rows[0].scope);
    assert.equal((await listReflectionRows(pluginConfig.dbPath)).length, 0, "delete removed the just-stored rows");

    // Release the gate: the generation handler resumes and reaches its
    // reflectionDerivedBySession cache write, which must now be skipped.
    releaseGate();
    postStoreGate = null;
    await handlerPromise;
    assert.equal(
      (await listReflectionRows(pluginConfig.dbPath)).length,
      0,
      "construction check: every store must precede the delete; no row may land after it",
    );

    const { derivedFocus } = getReflectionHooks(harness.eventHandlers);
    const out = await derivedFocus({}, { sessionKey, agentId: "agent-one" });
    assert.doesNotMatch(
      out?.prependContext ?? "",
      new RegExp(DERIVED_LINE),
      "the late cache write must not resurrect derived lines whose rows the delete just removed",
    );
  });
});
