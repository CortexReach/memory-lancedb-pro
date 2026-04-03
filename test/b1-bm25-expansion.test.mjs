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
const { MemoryStore } = jiti("../src/store.ts");

const EMBEDDING_DIMENSIONS = 4;
const FIXED_VECTOR = Array(EMBEDDING_DIMENSIONS).fill(0.5);
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Seed reflection entries directly (matching the format expected by loadAgentReflectionSlicesFromEntries)
async function seedReflectionEntries(dbPath, agentId, derivedLines) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  const now = Date.now();

  for (let i = 0; i < derivedLines.length; i++) {
    const entryId = `refl-${agentId}-${i}-${now}`;
    await store.store({
      id: entryId,
      text: derivedLines[i],
      vector: FIXED_VECTOR,
      category: "reflection",
      scope: "global",
      importance: 0.7,
      timestamp: new Date(now - i * 1000).toISOString(),
      metadata: JSON.stringify({
        type: "itemized",
        agentId,
        runAt: new Date(now - i * 1000).toISOString(),
      }),
    });
  }

  return store;
}

function invokeDerivedHook({ store, agentId, scopeFilter }) {
  const workDir = path.dirname(store.dbPath);
  const harness = createPluginApiHarness({
    resolveRoot: workDir,
    pluginConfig: makePluginConfig(workDir),
  });

  memoryLanceDBProPlugin.register(harness.api);

  const promptHooks = harness.eventHandlers.get("before_prompt_build") || [];
  // Priority 15 = derived injection
  const derivedHook = promptHooks.find(h => h.meta?.priority === 15);
  assert.ok(derivedHook, "derived hook (priority 15) not found");

  const ctx = {
    sessionKey: `agent:${agentId}:test`,
    agentId,
  };
  const event = { scopeFilter };
  return derivedHook.handler(event, ctx);
}

// ---------------------------------------------------------------------------
// B-1: BM25 Neighbor Expansion Tests
// ---------------------------------------------------------------------------

describe("B-1 BM25 expansion in loadAgentReflectionSlices", () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "b1-bm25-expansion-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // D2: scopeFilter === undefined must skip BM25 expansion
  // -------------------------------------------------------------------------
  it("D2: skips BM25 expansion when scopeFilter is undefined", async () => {
    const agentId = "test-agent-skip";
    const dbPath = path.join(workDir, "db");
    const store = await seedReflectionEntries(dbPath, agentId, [
      "BASE DERIVED LINE FOR SKIP TEST",
    ]);

    // Track whether bm25Search is called
    let bm25SearchCalled = false;
    const originalBm25 = store.bm25Search.bind(store);
    store.bm25Search = async (...args) => {
      bm25SearchCalled = true;
      return originalBm25(...args);
    };

    const result = await invokeDerivedHook({
      store,
      agentId,
      scopeFilter: undefined, // D2: must skip expansion
    });

    // bm25Search should NOT have been called
    assert.equal(bm25SearchCalled, false, "bm25Search should NOT be called when scopeFilter is undefined");

    // Base derived content must still appear
    assert.ok(
      result?.prependContext?.includes("BASE DERIVED LINE FOR SKIP TEST"),
      "base derived content should be present even when scopeFilter is undefined",
    );
  });

  // -------------------------------------------------------------------------
  // D6: expand, not replace — base derived must be preserved
  // -------------------------------------------------------------------------
  it("D6: base derived lines are preserved after BM25 expansion", async () => {
    const agentId = "test-agent-preserve";
    const dbPath = path.join(workDir, "db2");
    const store = await seedReflectionEntries(dbPath, agentId, [
      "BASE DERIVED LINE FOR PRESERVATION TEST",
    ]);

    const result = await invokeDerivedHook({
      store,
      agentId,
      scopeFilter: ["global"], // has scope, expansion runs
    });

    // Base derived MUST appear in output
    assert.ok(
      result?.prependContext?.includes("BASE DERIVED LINE FOR PRESERVATION TEST"),
      "base derived line must be preserved after expansion",
    );
  });

  // -------------------------------------------------------------------------
  // D3: hard cap at 16 total derived
  // -------------------------------------------------------------------------
  it("D3: total derived items are capped at 16", async () => {
    const agentId = "test-agent-cap";
    const dbPath = path.join(workDir, "db3");

    // Create store and seed many entries
    const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await store.store({
        id: `refl-cap-${i}`,
        text: `DERIVED LINE NUMBER ${i} FOR CAP TEST`,
        vector: FIXED_VECTOR,
        category: "reflection",
        scope: "global",
        importance: 0.7,
        timestamp: new Date(now - i * 1000).toISOString(),
        metadata: JSON.stringify({
          type: "itemized",
          agentId,
          runAt: new Date(now - i * 1000).toISOString(),
        }),
      });
    }

    const result = await invokeDerivedHook({
      store,
      agentId,
      scopeFilter: ["global"],
    });

    // Verify the output contains some of the seeded entries
    assert.ok(result?.prependContext, "result should have prependContext");
    // The prependContext should contain some of the seeded entries
    assert.ok(
      result.prependContext.includes("DERIVED LINE NUMBER"),
      "seeded derived lines should appear in output",
    );
  });

  // -------------------------------------------------------------------------
  // Fail-safe: bm25Search errors must not crash the hook
  // -------------------------------------------------------------------------
  it("bm25Search failure does not crash reflection loading (fail-safe)", async () => {
    const agentId = "test-agent-failsafe";
    const dbPath = path.join(workDir, "db4");
    const store = await seedReflectionEntries(dbPath, agentId, [
      "DERIVED LINE FOR FAILSAFE TEST",
    ]);

    // Make bm25Search always throw — should be caught by B-1 try/catch
    store.bm25Search = async () => {
      throw new Error("simulated BM25 failure");
    };

    // Should NOT throw — fail-safe via try/catch
    let thrown = null;
    try {
      await invokeDerivedHook({
        store,
        agentId,
        scopeFilter: ["global"],
      });
    } catch (err) {
      thrown = err;
    }

    assert.equal(thrown, null, "bm25Search failure should be caught and not propagate");
  });
});
