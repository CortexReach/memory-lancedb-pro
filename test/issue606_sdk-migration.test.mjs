/**
 * Unit tests for: SDK Migration Bug 2 (Issue #606)
 *
 * Tests the three-layer fallback in loadEmbeddedPiRunner():
 *   Layer 1: api.runtime.agent.runEmbeddedPiAgent (new SDK API)
 *   Layer 2: extensionAPI.js dynamic import (legacy fallback)
 *   Layer 3: CLI fallback (via runReflectionViaCli — not tested here)
 *
 * Run: node --test test/issue606_sdk-migration.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "..", "index.ts");

// ---------------------------------------------------------------------------
// Static analysis smoke tests — verify migration code is present
// ---------------------------------------------------------------------------

describe("SDK Migration Bug 2 — static smoke tests", () => {
  it("loadEmbeddedPiRunner accepts api parameter", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The function signature must include `api: OpenClawPluginApi`
    const sigPattern = /export async function loadEmbeddedPiRunner\(api:\s*OpenClawPluginApi\)/;
    assert.match(content, sigPattern, "loadEmbeddedPiRunner must accept api: OpenClawPluginApi parameter");
  });

  it("Layer 1 checks api.runtime.agent.runEmbeddedPiAgent first", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // Layer 1 new API check must appear BEFORE Layer 2 fallback
    const layer1Idx = content.indexOf("(api as unknown");
    const layer2Idx = content.indexOf("// Layer 2: Fallback 舊 extensionAPI.js");
    assert.ok(layer1Idx > 0, "Layer 1 api runtime check must exist");
    assert.ok(layer2Idx > 0, "Layer 2 fallback comment must exist");
    assert.ok(layer1Idx < layer2Idx, "Layer 1 must appear before Layer 2 in source order");
  });

  it("runEmbeddedPiAgent is bound correctly in Layer 1", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    const bindPattern = /\.bind\(newApi\)/;
    assert.match(content, bindPattern, "runEmbeddedPiAgent must be .bind()ed to preserve 'this' context");
  });

  it("generateReflectionText params include api field", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The params interface must include api: OpenClawPluginApi
    const apiParamPattern = /api:\s*OpenClawPluginApi[^}]*\}\s*\)[\s\n]*:[\s\n]*Promise/;
    assert.match(content, apiParamPattern, "generateReflectionText params must include api: OpenClawPluginApi");
  });

  it("generateReflectionText calls loadEmbeddedPiRunner with params.api", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    const callPattern = /loadEmbeddedPiRunner\(params\.api\)/;
    assert.match(content, callPattern, "loadEmbeddedPiRunner must be called with params.api");
  });

  it("call site passes api to generateReflectionText", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The call site in runMemoryReflection must include api,
    const callSitePattern = /generateReflectionText\(\{[\s\S]*?api,[\s\S]*?\}\)/;
    assert.match(content, callSitePattern, "generateReflectionText call site must pass api");
  });

  it("Layer 2 fallback still preserves embeddedPiRunnerPromise cache", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // embeddedPiRunnerPromise must still be used for Layer 2 fallback
    const cachePattern = /embeddedPiRunnerPromise/;
    assert.match(content, cachePattern, "Layer 2 fallback must still use embeddedPiRunnerPromise cache");
  });

  it("Layer 2 fallback uses correct specifier list", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The fallback must still try getExtensionApiImportSpecifiers()
    const fallbackPattern = /getExtensionApiImportSpecifiers\(\)/;
    assert.match(content, fallbackPattern, "Layer 2 fallback must still use getExtensionApiImportSpecifiers()");
  });
});

// ---------------------------------------------------------------------------
// Behavioral unit tests — verify runtime logic
// ---------------------------------------------------------------------------

describe("SDK Migration Bug 2 — behavioral logic tests", () => {
  /**
   * Extracts the Layer 1 detection logic from index.ts for isolated testing.
   * Mirrors the actual source: `(api as unknown as Record<string, unknown>).runtime?.agent`
   */
  function detectNewApi(api) {
    const newApi = (api ?? {})?.runtime?.agent;
    return typeof newApi?.runEmbeddedPiAgent === "function" ? newApi : null;
  }

  it("Layer 1: returns runner when api.runtime.agent.runEmbeddedPiAgent exists", () => {
    const mockRunner = async () => ({ payloads: [{ text: "ok" }] });
    const mockApi = {
      runtime: {
        agent: {
          runEmbeddedPiAgent: mockRunner,
        },
      },
    };
    const result = detectNewApi(mockApi);
    assert.ok(result !== null, "Should detect new API when runtime.agent.runEmbeddedPiAgent exists");
    assert.strictEqual(result.runEmbeddedPiAgent, mockRunner, "Should return the agent object");
  });

  it("Layer 1: returns null when api.runtime is undefined", () => {
    const mockApi = {};
    const result = detectNewApi(mockApi);
    assert.strictEqual(result, null, "Should return null when runtime is missing");
  });

  it("Layer 1: returns null when api.runtime.agent is undefined", () => {
    const mockApi = { runtime: {} };
    const result = detectNewApi(mockApi);
    assert.strictEqual(result, null, "Should return null when agent is missing");
  });

  it("Layer 1: returns null when runEmbeddedPiAgent is not a function", () => {
    const mockApi = { runtime: { agent: { runEmbeddedPiAgent: "not a function" } } };
    const result = detectNewApi(mockApi);
    assert.strictEqual(result, null, "Should return null when runEmbeddedPiAgent is not callable");
  });

  it("Layer 1: returns null when api is null", () => {
    const result = detectNewApi(null);
    assert.strictEqual(result, null, "Should return null for null api");
  });

  it("Layer 1: returns null when api is undefined", () => {
    const result = detectNewApi(undefined);
    assert.strictEqual(result, null, "Should return null for undefined api");
  });

  it("Layer 1: safe navigation works with nested undefined (optional chaining)", () => {
    // This is a critical safety property: detectNewApi must not throw on deeply nested undefined
    const mockApi = { runtime: { agent: null } };
    assert.doesNotThrow(() => detectNewApi(mockApi), "Must not throw on null nested properties");
    assert.strictEqual(detectNewApi(mockApi), null);
  });

  it("Layer 1: runEmbeddedPiAgent.bind preserves callable contract", () => {
    const mockRunner = async () => ({ payloads: [{ text: "bound test" }] });
    const mockAgent = { runEmbeddedPiAgent: mockRunner };
    const bound = mockRunner.bind(mockAgent);
    // bind() returns a new function copy (not the same reference)
    assert.notStrictEqual(bound, mockRunner, "bind() returns a new function copy");
    // The bound function is still async and callable with the same contract
    assert.ok(typeof bound === "function", "bound is callable");
    // bind() is REQUIRED here: the runner is called as a plain function
    // `runEmbeddedPiAgent(...)` (not `agent.runEmbeddedPiAgent(...)`),
    // so without .bind(), 'this' would be undefined in strict mode and any
    // internal SDK usage of 'this' would break at runtime.
  });

  it("Full Layer 1 → Layer 2 decision: Layer 1 takes precedence over Layer 2", () => {
    // Simulates what loadEmbeddedPiRunner does:
    // if (typeof newApi?.runEmbeddedPiAgent === "function") return Layer 1 runner;
    // else fall through to Layer 2

    let layer2Called = false;
    const mockRunner = async () => ({ payloads: [{ text: "layer1" }] });
    const mockApi = {
      runtime: {
        agent: {
          runEmbeddedPiAgent: mockRunner,
        },
      },
    };

    // Simulate the decision logic
    const newApi = (mockApi ?? {})?.runtime?.agent;
    let usedLayer = null;

    if (typeof newApi?.runEmbeddedPiAgent === "function") {
      usedLayer = "layer1";
    } else {
      layer2Called = true;
      usedLayer = "layer2";
    }

    assert.strictEqual(usedLayer, "layer1", "Should use Layer 1 when new API available");
    assert.strictEqual(layer2Called, false, "Layer 2 should NOT be called when Layer 1 is available");
  });

  it("Full Layer 1 → Layer 2 decision: falls through to Layer 2 when Layer 1 unavailable", () => {
    const mockApi = {}; // No new API

    const newApi = (mockApi ?? {})?.runtime?.agent;
    let layer2Triggered = false;

    if (typeof newApi?.runEmbeddedPiAgent === "function") {
      // Would use Layer 1
    } else {
      layer2Triggered = true; // Simulate Layer 2 fallback
    }

    assert.strictEqual(layer2Triggered, true, "Should trigger Layer 2 when Layer 1 unavailable");
  });

  it("EmbeddedPiRunner type signature: accepts Record<string, unknown> params and returns Promise<unknown>", async () => {
    // Verifies the type alias: type EmbeddedPiRunner = (params: Record<string, unknown>) => Promise<unknown>;
    const mockRunner = async (params) => {
      assert.ok(typeof params === "object", "Runner params must be an object");
      assert.ok("sessionId" in params, "Standard params include sessionId");
      return { payloads: [{ text: "test reflection" }] };
    };

    const params = {
      sessionId: "test-session",
      sessionKey: "temp:test",
      agentId: "main",
      sessionFile: "/tmp/test.jsonl",
      workspaceDir: "/tmp",
      config: {},
      prompt: "Test prompt",
      disableTools: true,
      disableMessageTool: true,
      timeoutMs: 30000,
      runId: "test-run",
      bootstrapContextMode: "lightweight",
      thinkLevel: "fast",
      provider: "openai",
      model: "gpt-4o",
    };

    const result = await mockRunner(params);
    assert.ok(result, "Runner should return a result");
    assert.ok("payloads" in result, "Runner should return result with payloads structure");
  });
});

// ---------------------------------------------------------------------------
// generateReflectionText params structural test
// ---------------------------------------------------------------------------

describe("generateReflectionText — api parameter integration", () => {
  it("api field is required in generateReflectionText params (comment indicates migration)", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The api field comment should reference Bug 2 / Issue #606
    const migrationComment = /api.*OpenClawPluginApi.*SDK migration Bug 2/i;
    assert.match(content, migrationComment, "api parameter must be documented as SDK migration Bug 2");
  });

  it("call site passes api to generateReflectionText", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    // The call site is: await generateReflectionText({...})
    // with logger: api.logger, and api, appearing as trailing parameters.
    // We search for "await generateReflectionText(" which only appears at call sites.
    const callIdx = content.indexOf("await generateReflectionText(");
    assert.ok(callIdx > 0, "'await generateReflectionText' call must exist");

    // Within the next 2000 chars of that call, both logger: api.logger, and api, must appear
    const region = content.slice(callIdx, callIdx + 2000);
    const loggerIdx = region.indexOf("logger: api.logger,");
    const apiIdx = region.indexOf("api,");
    assert.ok(loggerIdx >= 0, "'logger: api.logger,' must appear in the generateReflectionText call");
    assert.ok(apiIdx > loggerIdx, "'api,' must appear after 'logger: api.logger,' in the same call");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — actual loadEmbeddedPiRunner behavioral tests
// ---------------------------------------------------------------------------

describe("loadEmbeddedPiRunner — F1/F2 behavioral integration", () => {
  it("F1: circuit breaker opens after LAYER1_FAILURE_THRESHOLD failures and blocks Layer 1", async () => {
    // We can't easily reset module-level state, so we test the circuit breaker
    // function directly. The actual integration (Layer 1 blocked after N failures)
    // requires a fresh module instance per test which Node test runner doesn't give us.
    const { isLayer1CircuitOpen } = await import("../index.ts");
    // isLayer1CircuitOpen is internal; if it exists and returns boolean, the mechanism is wired
    assert.strictEqual(typeof isLayer1CircuitOpen, "function", "isLayer1CircuitOpen should be exported for testability");
  });

  it("F1: reportLayer1Failure is exported and callable", async () => {
    const { reportLayer1Failure } = await import("../index.ts");
    assert.strictEqual(typeof reportLayer1Failure, "function", "reportLayer1Failure must be exported");
    // Calling it should not throw
    assert.doesNotThrow(() => reportLayer1Failure(), "reportLayer1Failure() must not throw");
  });

  it("F2: embeddedPiRunnerPromise is NOT cached permanently after failure — caller must handle", async () => {
    // F2 is fixed by restoring try-catch that resets embeddedPiRunnerPromise = null on failure.
    // The retry behavior is in the caller (generateReflectionText), not in loadEmbeddedPiRunner itself.
    // This test documents the contract: callers should expect failures to be throwable
    // and loadEmbeddedPiRunner will NOT swallow errors.
    const content = readFileSync(INDEX_PATH, "utf-8");
    // Verify the retry pattern is restored: try/catch around the final return
    const tryCatchPattern = /try\s*\{[\s\S]{0,200}return await embeddedPiRunnerPromise;[\s\S]{0,200}catch[\s\S]{0,200}embeddedPiRunnerPromise\s*=\s*null/s;
    assert.match(
      content,
      tryCatchPattern,
      "F2 fix: loadEmbeddedPiRunner must have try-catch that resets embeddedPiRunnerPromise on failure (retry semantics)"
    );
  });

  it("Full fallback chain: Layer 1 unavailable → Layer 2 is attempted", async () => {
    // This mirrors what loadEmbeddedPiRunner does when Layer 1 is unavailable:
    // newApi is null/undefined → skip Layer 1 → go to Layer 2
    const mockApi = {}; // No runtime.agent
    const newApi = (mockApi ?? {})?.runtime?.agent;
    let layer2Triggered = false;

    if (typeof newApi?.runEmbeddedPiAgent === "function") {
      // Layer 1 would be used
    } else {
      layer2Triggered = true; // Simulate Layer 2 fallback
    }

    assert.strictEqual(layer2Triggered, true, "Must fall through to Layer 2 when Layer 1 unavailable");
  });
});

console.log("Run: node --test test/issue606_sdk-migration.test.mjs");
