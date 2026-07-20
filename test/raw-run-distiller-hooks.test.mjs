// Regression test: the reflection distiller's embedded sub-run must request
// raw-run semantics so the host skips before_prompt_build dispatch for EVERY
// registered plugin, not just this plugin's own hooks.
//
// #916 and #922 guarded this plugin's OWN before_prompt_build hooks against
// the distiller's sub-session (sessionKey "temp:memory-reflection:<agentId>").
// That left every OTHER plugin's before_prompt_build hooks still firing into
// the sub-run, since the host's dispatch guard (shouldSkipPromptBuildHooks)
// only skips a run when the caller marks it raw. Live trace evidence: a
// foreign plugin's ~16.6KB injected system-context block (recall-tool policy
// text for tools this sub-run doesn't have) was prepended to the distiller's
// model call.
//
// Fix: pass modelRun: true in the runEmbeddedPiAgent call. The host derives
// isRawModelRun = params.modelRun === true || params.promptMode === "none",
// and shouldSkipPromptBuildHooks({ isRawModelRun }) short-circuits the whole
// before_prompt_build dispatch (all plugins) when that's true.
//
// Run: node --test test/raw-run-distiller-hooks.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(testDir, "..", "index.ts");
const pluginSdkStubPath = resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { generateReflectionText } = jiti("../index.ts");

// loadEmbeddedPiRunner caches the first Layer-1 runner it resolves module-wide
// (see test/reflection-per-agent-lane.test.mjs), so every test in this file
// shares ONE fake api and swaps behavior via this dispatcher.
let currentRunnerImpl = async () => ({ payloads: [{ text: "noop" }] });
const fakeApi = {
  runtime: {
    agent: {
      runEmbeddedPiAgent: (params) => currentRunnerImpl(params),
    },
  },
};

const baseParams = {
  conversation: "user: hello\nassistant: hi",
  maxInputChars: 1000,
  cfg: {},
  agentId: "agent-one",
  workspaceDir: "/tmp",
  timeoutMs: 2000,
  thinkLevel: "off",
  api: fakeApi,
};

describe("reflection distiller requests raw-run semantics", () => {
  it("passes modelRun: true to the embedded runner (host skips foreign before_prompt_build hooks for this call)", async () => {
    let seenParams = null;
    currentRunnerImpl = async (params) => {
      seenParams = params;
      return { payloads: [{ text: "reflection text" }] };
    };

    const result = await generateReflectionText(baseParams);

    assert.equal(result.runner, "embedded");
    assert.ok(seenParams, "the embedded runner must have been invoked");
    assert.equal(
      seenParams.modelRun,
      true,
      "the distiller sub-run must set modelRun: true so the host's shouldSkipPromptBuildHooks " +
        "resolves isRawModelRun and skips before_prompt_build dispatch for every plugin"
    );
  });

  it("keeps the explicit promptMode: \"minimal\" surface alongside modelRun (host honors an explicit promptMode over the raw-run default of \"none\")", async () => {
    let seenParams = null;
    currentRunnerImpl = async (params) => {
      seenParams = params;
      return { payloads: [{ text: "reflection text" }] };
    };

    await generateReflectionText(baseParams);

    assert.equal(seenParams.promptMode, "minimal");
    assert.equal(seenParams.disableTools, true);
    assert.equal(seenParams.disableMessageTool, true);
  });

  it("is the plugin's only runEmbeddedPiAgent call site (regression guard: no other call site was silently marked raw)", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    const callSites = content.split("runEmbeddedPiAgent({").length - 1;
    assert.equal(
      callSites,
      1,
      "expected exactly one runEmbeddedPiAgent call site (the reflection distiller); " +
        "a new call site needs its own raw-run review, not an accidental inherited flag"
    );
  });

  it("sets modelRun unconditionally (no host-version feature-detection gate); hosts that ignore the field fail open to prior behavior", () => {
    const content = readFileSync(INDEX_PATH, "utf-8");
    const callIdx = content.indexOf("runEmbeddedPiAgent({");
    assert.ok(callIdx > 0, "embedded reflection runner call must exist");
    const payloadRegion = content.slice(callIdx, callIdx + 1200);
    assert.match(
      payloadRegion,
      /\n\s*modelRun: true,\n/,
      "modelRun: true must be an unconditional literal in the runner payload, not gated behind a capability check"
    );
  });
});
