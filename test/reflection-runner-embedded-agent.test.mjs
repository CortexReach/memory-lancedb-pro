/**
 * reflection-runner-embedded-agent.test.mjs
 *
 * The host renamed api.runtime.agent.runEmbeddedPiAgent to runEmbeddedAgent
 * and removed the alias; `openclaw agent --local` is refused while a gateway
 * owns the state directory; and CLI startup banners pushed the real failure
 * reason out of the clipped diagnostic. Reflection must pick the new runner
 * name (still accepting the old one), keep the distiller run detached from the
 * session store, drive the CLI fallback through `agent exec`, and report the
 * tail of stderr. Fixtures are synthetic.
 *
 * Run: node --test test/reflection-runner-embedded-agent.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");

function loadFreshIndex() {
  const jiti = jitiFactory(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
  });
  return jiti("../index.ts");
}

const { resolveEmbeddedRunnerExportName } = loadFreshIndex();

const noop = async () => ({ payloads: [{ text: "noop" }] });

describe("embedded runner export resolution", () => {
  it("prefers runEmbeddedAgent when the host exposes both names", () => {
    const name = resolveEmbeddedRunnerExportName({ runEmbeddedAgent: noop, runEmbeddedPiAgent: noop });
    assert.equal(name, "runEmbeddedAgent");
  });

  it("still accepts the legacy runEmbeddedPiAgent name", () => {
    assert.equal(resolveEmbeddedRunnerExportName({ runEmbeddedPiAgent: noop }), "runEmbeddedPiAgent");
  });

  it("returns undefined for hosts without a callable runner", () => {
    assert.equal(resolveEmbeddedRunnerExportName({ runEmbeddedAgent: "not a function" }), undefined);
    assert.equal(resolveEmbeddedRunnerExportName(undefined), undefined);
    assert.equal(resolveEmbeddedRunnerExportName(null), undefined);
    assert.equal(resolveEmbeddedRunnerExportName({}), undefined);
  });
});

describe("reflection distiller on a renamed-runner host", () => {
  it("invokes runEmbeddedAgent with a detached, tool-free minimal model run", async () => {
    const { generateReflectionText } = loadFreshIndex();
    let seenParams = null;
    let legacyCalls = 0;
    const api = {
      runtime: {
        agent: {
          runEmbeddedAgent: async (params) => {
            seenParams = params;
            return { payloads: [{ text: "distilled reflection" }] };
          },
          runEmbeddedPiAgent: async () => {
            legacyCalls += 1;
            return { payloads: [{ text: "legacy" }] };
          },
        },
      },
    };

    const result = await generateReflectionText({
      conversation: "user: the build is green\nassistant: noted",
      maxInputChars: 1000,
      cfg: { llm: { model: "openrouter/example/model-one" } },
      agentId: "agent-one",
      workspaceDir: "/tmp",
      timeoutMs: 2000,
      thinkLevel: "off",
      api,
    });

    assert.equal(result.runner, "embedded");
    assert.equal(result.text, "distilled reflection");
    assert.equal(legacyCalls, 0, "the legacy alias must not be called when the new name exists");
    assert.ok(seenParams, "runEmbeddedAgent must have been invoked");
    assert.equal(seenParams.sessionPersistence, "detached");
    assert.equal(seenParams.modelRun, true);
    assert.equal(seenParams.promptMode, "minimal");
    assert.equal(seenParams.disableTools, true);
    assert.equal(seenParams.provider, "openrouter");
    assert.equal(seenParams.model, "example/model-one");
    assert.equal(seenParams.sessionFile, undefined, "current hosts refuse a non-key sessionFile for plugin runs");
  });

  it("still hands the legacy runner a transcript file path", async () => {
    const { generateReflectionText } = loadFreshIndex();
    let seenParams = null;
    const api = {
      runtime: {
        agent: {
          runEmbeddedPiAgent: async (params) => {
            seenParams = params;
            return { payloads: [{ text: "legacy reflection" }] };
          },
        },
      },
    };

    const result = await generateReflectionText({
      conversation: "user: the build is green\nassistant: noted",
      maxInputChars: 1000,
      cfg: {},
      agentId: "agent-one",
      workspaceDir: "/tmp",
      timeoutMs: 2000,
      thinkLevel: "off",
      api,
    });

    assert.equal(result.runner, "embedded");
    assert.equal(typeof seenParams.sessionFile, "string");
    assert.ok(seenParams.sessionFile.endsWith(".jsonl"), seenParams.sessionFile);
  });
});

describe("tool-free completion fallback", () => {
  const conversation = "user: the build is green\nassistant: noted";
  const failingApi = {
    runtime: {
      agent: {
        runEmbeddedAgent: async () => {
          throw new Error("embedded runner refused");
        },
      },
    },
  };

  it("hands the reflection prompts to the completion when the embedded runner fails", async () => {
    const { generateReflectionText } = loadFreshIndex();
    const seen = [];
    const result = await generateReflectionText({
      conversation,
      maxInputChars: 1000,
      cfg: {},
      agentId: "agent-one",
      workspaceDir: "/tmp",
      timeoutMs: 2000,
      thinkLevel: "off",
      api: failingApi,
      completeText: async (systemPrompt, userPrompt) => {
        seen.push({ systemPrompt, userPrompt });
        return "  distilled by completion  ";
      },
    });
    assert.equal(result.runner, "completion");
    assert.equal(result.usedFallback, false);
    assert.equal(result.text, "  distilled by completion  ");
    assert.equal(seen.length, 1, "one completion call");
    assert.ok(seen[0].systemPrompt.length > 0, "the distiller system prompt travels as the system message");
    assert.ok(seen[0].userPrompt.includes("the build is green"), "the transcript travels in the user prompt");
    assert.match(result.error ?? "", /embedded runner refused/);
  });

  it("falls through to the static fallback text when the completion returns nothing", async () => {
    const { generateReflectionText } = loadFreshIndex();
    const result = await generateReflectionText({
      conversation,
      maxInputChars: 1000,
      cfg: {},
      agentId: "agent-one",
      workspaceDir: "/tmp",
      timeoutMs: 2000,
      thinkLevel: "off",
      api: failingApi,
      completeText: async () => null,
    });
    assert.equal(result.runner, "fallback");
    assert.equal(result.usedFallback, true);
    assert.match(result.error ?? "", /completion returned no text/);
  });

  it("reports the missing completion client instead of reaching for a CLI", async () => {
    const { generateReflectionText } = loadFreshIndex();
    const result = await generateReflectionText({
      conversation,
      maxInputChars: 1000,
      cfg: {},
      agentId: "agent-one",
      workspaceDir: "/tmp",
      timeoutMs: 2000,
      thinkLevel: "off",
      api: failingApi,
    });
    assert.equal(result.runner, "fallback");
    assert.match(result.error ?? "", /no tool-free completion client/);
  });
});

describe("embedded runner cache", () => {
  it("keeps the runner and its kind together across host surfaces", async () => {
    const { generateReflectionText, getEmbeddedRunnerExportName } = loadFreshIndex();
    const legacyParams = [];
    let currentCalls = 0;
    const legacyApi = {
      runtime: {
        agent: {
          runEmbeddedPiAgent: async (params) => {
            legacyParams.push(params);
            return { payloads: [{ text: "legacy" }] };
          },
        },
      },
    };
    const currentApi = {
      runtime: {
        agent: {
          runEmbeddedAgent: async () => {
            currentCalls += 1;
            return { payloads: [{ text: "current" }] };
          },
        },
      },
    };
    const base = { conversation: "user: hi\nassistant: hello", maxInputChars: 1000, cfg: {}, agentId: "agent-one", workspaceDir: "/tmp", timeoutMs: 2000, thinkLevel: "off" };

    const first = await generateReflectionText({ ...base, api: legacyApi });
    assert.equal(first.text, "legacy");
    assert.equal(getEmbeddedRunnerExportName(), "runEmbeddedPiAgent");
    assert.equal(typeof legacyParams[0].sessionFile, "string", "the legacy runner gets its transcript file");

    const second = await generateReflectionText({ ...base, api: currentApi });
    assert.equal(second.text, "legacy", "the cached runner keeps serving");
    assert.equal(currentCalls, 0, "a later host surface does not replace the cached runner");
    assert.equal(getEmbeddedRunnerExportName(), "runEmbeddedPiAgent", "the cached kind stays with the cached runner");
    assert.equal(typeof legacyParams[1].sessionFile, "string", "the second run is still labeled legacy and keeps the transcript file");
  });
});

describe("reflection agent model routing", () => {
  const defaultModel = { primary: "default-provider/default-model" };
  const fixtures = [
    ["keyed object model", {
      agents: { entries: { "agent-one": { model: { primary: "entry-provider/entry-model" } } }, defaults: { model: defaultModel } },
    }, undefined, "entry-provider", "entry-model"],
    ["keyed string model", {
      agents: { entries: { "agent-one": { model: "entry-provider/entry-model" } }, defaults: { model: defaultModel } },
    }, undefined, "entry-provider", "entry-model"],
    ["exact requested keyed agent instead of another entry", {
      agents: { ownership: "explicit", entries: {
        "agent-two": { model: "other-provider/other-model" },
        "agent-one": { model: "entry-provider/entry-model" },
      }, defaults: { model: defaultModel } },
    }, undefined, "entry-provider", "entry-model"],
    ["explicit reflection override before the keyed model", {
      agents: { entries: { "agent-one": { model: "entry-provider/entry-model" } }, defaults: { model: defaultModel } },
    }, "override-provider/override-model", "override-provider", "override-model"],
    ["default object when the keyed agent has no model", {
      agents: { entries: { "agent-one": {} }, defaults: { model: defaultModel } },
    }, undefined, "default-provider", "default-model"],
    ["default string model", {
      agents: { entries: { "agent-one": {} }, defaults: { model: "default-provider/default-model" } },
    }, undefined, "default-provider", "default-model"],
    ["legacy array with an object model", {
      agents: { list: [{ id: "agent-one", model: { primary: "legacy-provider/legacy-model" } }], defaults: { model: defaultModel } },
    }, undefined, "legacy-provider", "legacy-model"],
    ["legacy array with a string model", {
      agents: { list: [{ id: "agent-one", model: "legacy-provider/legacy-model" }], defaults: { model: defaultModel } },
    }, undefined, "legacy-provider", "legacy-model"],
    ["blank keyed model falls back to the default", {
      agents: { entries: { "agent-one": { model: "  " } }, defaults: { model: defaultModel } },
    }, undefined, "default-provider", "default-model"],
    ["existing llm model fallback without an agent model", {
      agents: { entries: { "agent-one": {} } }, llm: { model: "llm-provider/llm-model" },
    }, undefined, "llm-provider", "llm-model"],
  ];

  for (const [name, cfg, model, provider, modelId] of fixtures) {
    it(`uses ${name}`, async () => {
      const { generateReflectionText } = loadFreshIndex();
      let seen;
      const result = await generateReflectionText({
        conversation: "user: synthetic routing input\nassistant: acknowledged",
        maxInputChars: 1000, cfg, model, agentId: "agent-one",
        workspaceDir: "/tmp", timeoutMs: 2000, thinkLevel: "off",
        api: { runtime: { agent: { runEmbeddedAgent: async (params) => {
          seen = params;
          return { payloads: [{ text: "synthetic reflection" }] };
        } } } },
      });
      assert.equal(result.runner, "embedded");
      assert.equal(seen.provider, provider);
      assert.equal(seen.model, modelId);
    });
  }
});
