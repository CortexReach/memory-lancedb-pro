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
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
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
    assert.equal(getEmbeddedRunnerExportName(legacyApi), "runEmbeddedPiAgent");
    assert.equal(typeof legacyParams[0].sessionFile, "string", "the legacy runner gets its transcript file");

    const second = await generateReflectionText({ ...base, api: currentApi });
    assert.equal(second.text, "current", "the second host must use its own runner");
    assert.equal(currentCalls, 1, "the later host resolves a separate runner");
    assert.equal(getEmbeddedRunnerExportName(legacyApi), "runEmbeddedPiAgent", "the cached kind stays with the cached runner");
    assert.equal(legacyParams.length, 1, "the second host must never call the first host runner");
    assert.equal(getEmbeddedRunnerExportName(currentApi), "runEmbeddedAgent");
  });
});

// Keep the host boundary tests on both the source entry and the published native
// ESM entry: multiple register() contexts share one imported plugin module.
for (const target of ["source", "published dist"]) {
  describe(`host-scoped reflection runners (${target})`, () => {
    let instance = 0;
    async function loadModule() {
      if (target === "source") return loadFreshIndex();
      const url = pathToFileURL(path.resolve(testDir, "../dist/index.js"));
      url.searchParams.set("host-cache-test", String(++instance));
      return import(url.href);
    }
    const base = {
      conversation: "user: the build is green\nassistant: noted",
      maxInputChars: 1000, cfg: {}, agentId: "test-agent",
      workspaceDir: tmpdir(), timeoutMs: 2000, thinkLevel: "off",
    };
    function host(label, exportName = "runEmbeddedAgent") {
      const calls = [];
      const agent = {
        label,
        async [exportName](params) {
          assert.equal(this, agent, "the host runner retains its receiver");
          calls.push(params);
          return { payloads: [{ text: this.label }] };
        },
      };
      return { api: { runtime: { agent } }, calls };
    }

    it("uses each current host's runner even when a retired host was resolved first", async () => {
      const mod = await loadModule();
      const first = host("first");
      const second = host("second");
      assert.equal((await mod.generateReflectionText({ ...base, api: first.api })).text, "first");
      first.api.runtime.agent.label = "retired";
      assert.equal((await mod.generateReflectionText({ ...base, api: second.api })).text, "second");
      assert.equal(first.calls.length, 1, "the retired host must not run again");
      assert.equal(second.calls.length, 1);
    });

    for (const firstKind of ["runEmbeddedAgent", "runEmbeddedPiAgent"]) {
      it(`keeps each runner's transcript contract when ${firstKind} resolves first`, async () => {
        const mod = await loadModule();
        const current = host("current");
        const legacy = host("legacy", "runEmbeddedPiAgent");
        const ordered = firstKind === "runEmbeddedAgent" ? [current, legacy] : [legacy, current];
        for (const item of ordered) {
          const result = await mod.generateReflectionText({ ...base, api: item.api });
          assert.equal(result.text, item.api.runtime.agent.label);
          assert.equal(result.runner, "embedded");
        }
        assert.equal(current.calls[0].sessionFile, undefined);
        assert.equal(typeof legacy.calls[0].sessionFile, "string");
        assert.equal(current.calls[0].sessionPersistence, "detached");
        assert.equal(mod.getEmbeddedRunnerExportName(current.api), "runEmbeddedAgent");
        assert.equal(mod.getEmbeddedRunnerExportName(legacy.api), "runEmbeddedPiAgent");
      });
    }

    it("keeps concurrent hosts separate while reusing a resolution within one host", async () => {
      const mod = await loadModule();
      const current = host("current");
      const legacy = host("legacy", "runEmbeddedPiAgent");
      const [one, same, other] = await Promise.all([
        mod.loadEmbeddedPiRunner(current.api), mod.loadEmbeddedPiRunner(current.api),
        mod.loadEmbeddedPiRunner(legacy.api),
      ]);
      assert.equal(one, same, "a host shares its resolved runner");
      assert.notEqual(one, other, "different hosts cannot share a bound runner");
      const results = await Promise.all([current, legacy].map(({ api }) =>
        mod.generateReflectionText({ ...base, api, maxConcurrentRuns: 2 })));
      assert.deepEqual(results.map(r => r.text), ["current", "legacy"]);
      assert.equal(current.calls[0].sessionFile, undefined);
      assert.equal(typeof legacy.calls[0].sessionFile, "string");
    });

    it("does not let another host's circuit failures suppress a healthy SDK runner", async () => {
      const mod = await loadModule();
      const failing = host("failing");
      failing.api.runtime.agent.runEmbeddedAgent = async () => { throw new Error("host unavailable"); };
      for (let i = 0; i < 3; i++) {
        const result = await mod.generateReflectionText({ ...base, api: failing.api });
        assert.equal(result.runner, "fallback");
      }
      assert.equal(mod.isLayer1CircuitOpen(failing.api), true);
      const healthy = host("healthy");
      assert.equal(mod.isLayer1CircuitOpen(healthy.api), false);
      assert.equal((await mod.generateReflectionText({ ...base, api: healthy.api })).text, "healthy");
      assert.equal(healthy.calls.length, 1);
    });

    if (target === "published dist") it("retries a rejected resolution without clearing another host's cached runner", async () => {
      const mod = await loadModule();
      const missing = {};
      // Reject every extension fallback in this fixture, including a developer's
      // globally installed host. Exercise the real rejected-promise cache path.
      const directory = await mkdtemp(path.join(tmpdir(), "reflection-runner-cache-"));
      const previous = process.env.OPENCLAW_EXTENSION_API_PATH;
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.includes("extensionAPI.js") || specifier.endsWith("missing.mjs")) {
            throw Object.assign(new Error("fixture: extension API unavailable"), { code: "ERR_MODULE_NOT_FOUND" });
          }
          return nextResolve(specifier, context);
        },
      });
      try {
        process.env.OPENCLAW_EXTENSION_API_PATH = path.join(directory, "missing.mjs");
        const rejected = await Promise.allSettled([
          mod.loadEmbeddedPiRunner(missing), mod.loadEmbeddedPiRunner(missing),
        ]);
        assert.deepEqual(rejected.map(r => r.status), ["rejected", "rejected"]);
        const healthy = host("healthy");
        const cached = await mod.loadEmbeddedPiRunner(healthy.api);
        const repaired = host("repaired");
        missing.runtime = repaired.api.runtime;
        assert.equal((await mod.generateReflectionText({ ...base, api: missing })).text, "repaired");
        assert.equal(await mod.loadEmbeddedPiRunner(healthy.api), cached);
        assert.equal((await mod.generateReflectionText({ ...base, api: healthy.api })).text, "healthy");
      } finally {
        hooks.deregister();
        if (previous === undefined) delete process.env.OPENCLAW_EXTENSION_API_PATH;
        else process.env.OPENCLAW_EXTENSION_API_PATH = previous;
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}
