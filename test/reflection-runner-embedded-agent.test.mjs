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

const {
  resolveEmbeddedRunnerExportName,
  buildReflectionCliArgs,
  shouldRetryReflectionCliAsLegacyLocal,
  clipDiagnosticTail,
  extractReflectionTextFromCliResult,
} = loadFreshIndex();

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

describe("CLI fallback argument shape", () => {
  const base = {
    agentId: "agent-one",
    prompt: "line one\nline two",
    workspaceDir: "/tmp/workspace-one",
    thinkLevel: "low",
    agentTimeoutSec: 30,
    sessionId: "memory-reflection-cli-1",
  };

  it("drives a headless exec turn and never asks for --local", () => {
    const args = buildReflectionCliArgs({ ...base, mode: "exec", modelRef: "openrouter/example/model-one" });
    assert.deepEqual(args.slice(0, 2), ["agent", "exec"]);
    assert.ok(!args.includes("--local"), `--local must be absent: ${JSON.stringify(args)}`);
    assert.ok(!args.includes("--agent"), "exec has no agent selector");
    assert.ok(!args.includes(base.prompt), "the prompt travels over stdin, not argv");
    assert.deepEqual(args.slice(args.indexOf("--message-file"), args.indexOf("--message-file") + 2), ["--message-file", "-"]);
    assert.deepEqual(args.slice(args.indexOf("--cwd"), args.indexOf("--cwd") + 2), ["--cwd", base.workspaceDir]);
    assert.ok(args.includes("--json"));
    assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "low"]);
    assert.deepEqual(args.slice(args.indexOf("--timeout"), args.indexOf("--timeout") + 2), ["--timeout", "30"]);
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "openrouter/example/model-one"]);
  });

  it("omits --model when no provider-qualified ref resolved", () => {
    const args = buildReflectionCliArgs({ ...base, mode: "exec" });
    assert.ok(!args.includes("--model"));
  });

  it("keeps the legacy --local shape for hosts that predate agent exec", () => {
    const args = buildReflectionCliArgs({ ...base, mode: "legacy-local" });
    assert.deepEqual(args, [
      "agent",
      "--local",
      "--agent",
      "agent-one",
      "--message",
      base.prompt,
      "--json",
      "--thinking",
      "low",
      "--timeout",
      "30",
      "--session-id",
      "memory-reflection-cli-1",
    ]);
  });
});

describe("legacy retry decision", () => {
  const run = (stderr, code = 1) => ({ stderr, code, signal: null, timedOut: false });

  it("retries only when the host rejected the exec argument shape", () => {
    assert.equal(shouldRetryReflectionCliAsLegacyLocal(run("error: unknown command 'exec'")), true);
    assert.equal(shouldRetryReflectionCliAsLegacyLocal(run("error: too many arguments for 'agent'. Expected 0 arguments but got 1.")), true);
    assert.equal(shouldRetryReflectionCliAsLegacyLocal(run('\u001b[31mOpenClaw does not recognize option "--message-file".\u001b[39m')), true);
  });

  it("does not retry runtime failures, successes, signals or timeouts", () => {
    assert.equal(shouldRetryReflectionCliAsLegacyLocal(run("A Gateway is running for this state directory (pid 1, port 2).")), false);
    assert.equal(shouldRetryReflectionCliAsLegacyLocal(run("error: unknown command 'exec'", 0)), false);
    assert.equal(shouldRetryReflectionCliAsLegacyLocal({ stderr: "error: unknown command 'exec'", code: null, signal: "SIGTERM", timedOut: false }), false);
    assert.equal(shouldRetryReflectionCliAsLegacyLocal({ stderr: "error: unknown command 'exec'", code: null, signal: null, timedOut: true }), false);
  });
});

describe("CLI diagnostic clipping", () => {
  it("drops state-migration banners and ANSI noise, keeping the failure reason", () => {
    const stderr = [
      "\u001b[33m[state-migrations]\u001b[39m legacy allowFrom file left in place: /tmp/one.json",
      "[state-migrations] legacy allowFrom file left in place: /tmp/two.json",
      "",
      "A Gateway is running for this state directory (pid 1, port 2). Run without --local to use it.",
    ].join("\n");
    const clipped = clipDiagnosticTail(stderr);
    assert.ok(!clipped.includes("state-migrations"), clipped);
    assert.ok(!clipped.includes("\u001b["), clipped);
    assert.ok(clipped.includes("Run without --local to use it."), clipped);
  });

  it("keeps the tail when the text is longer than the budget", () => {
    const filler = "banner ".repeat(200);
    const clipped = clipDiagnosticTail(`${filler}final reason here`, 60);
    assert.ok(clipped.startsWith("..."), clipped);
    assert.ok(clipped.endsWith("final reason here"), clipped);
    assert.equal(clipped.length, 60);
  });
});

describe("CLI result extraction", () => {
  it("reads the exec envelope payloads and falls back to final", () => {
    assert.equal(extractReflectionTextFromCliResult({ ok: true, payloads: [{ text: " from payloads " }], final: "from final" }), "from payloads");
    assert.equal(extractReflectionTextFromCliResult({ ok: true, payloads: [], final: " from final " }), "from final");
    assert.equal(extractReflectionTextFromCliResult({ result: { payloads: [{ text: "legacy envelope" }] } }), "legacy envelope");
    assert.equal(extractReflectionTextFromCliResult({ ok: true, payloads: [] }), null);
  });
});
