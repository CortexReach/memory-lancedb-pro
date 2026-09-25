/**
 * cli-metadata-registration.test.mjs
 *
 * The host registers plugins in "cli-metadata" mode to collect the CLI
 * command tree before any runtime exists: api.runtime is a proxy that throws
 * on access and nothing registered in that pass ever runs. register() used to
 * probe api.runtime while wiring the LLM client, so every CLI process logged
 * "smart extraction init failed" and fell back to regex. The probe must read a
 * throwing runtime as "unavailable", the metadata pass must skip the LLM
 * wiring, and the root command must be declared in the manifest so the host
 * can plan the CLI without loading the plugin. Fixtures are synthetic.
 *
 * Run: node --test test/cli-metadata-registration.test.mjs
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(testDir, "..", "openclaw.plugin.json");
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;
const resetRegistration = pluginModule.resetRegistration ?? (() => {});
const { resolveRuntimeLlmComplete, isCliMetadataRegistration, MEMORY_PRO_CLI_DESCRIPTOR } = pluginModule;

function createThrowingRuntime() {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === "symbol") return undefined;
      throw new Error(`runtime is intentionally unavailable during "cli-metadata" registration (${String(property)})`);
    },
  });
}

function createPluginApiHarness({ pluginConfig, resolveRoot, registrationMode, runtime }) {
  const logs = [];
  const cliRegistrations = [];
  const api = {
    registrationMode,
    runtime,
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      return path.isAbsolute(target) ? target : path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.push(["info", String(message)]); },
      warn(message) { logs.push(["warn", String(message)]); },
      debug(message) { logs.push(["debug", String(message)]); },
      error(message) { logs.push(["error", String(message)]); },
    },
    registerTool() {},
    registerCli(registrar, opts) { cliRegistrations.push({ registrar, opts }); },
    registerService() {},
    on() {},
    registerHook() {},
  };
  return { api, logs, cliRegistrations };
}

function makePluginConfig(workDir, overrides = {}) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: { apiKey: "test-api-key", dimensions: 4 },
    llm: { transport: "host", model: "openrouter/example/model-one" },
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: false, beforeResetNote: false, ensureLearningFiles: false },
    memoryReflection: { excludeAgents: [] },
    ...overrides,
  };
}

describe("runtime LLM probe", () => {
  it("reads the metadata-only registration's throwing runtime as unavailable", () => {
    assert.equal(
      resolveRuntimeLlmComplete({ registrationMode: "cli-metadata", runtime: createThrowingRuntime() }),
      undefined,
    );
  });

  it("surfaces a throwing runtime in every other registration mode", () => {
    assert.throws(
      () => resolveRuntimeLlmComplete({ registrationMode: "full", runtime: createThrowingRuntime() }),
      /intentionally unavailable/,
    );
    assert.throws(() => resolveRuntimeLlmComplete({ runtime: createThrowingRuntime() }), /intentionally unavailable/);
  });

  it("still binds the host completion surface when it exists", async () => {
    const complete = async () => ({ text: "ok" });
    const bound = resolveRuntimeLlmComplete({ runtime: { llm: { complete } } });
    assert.equal(typeof bound, "function");
    assert.deepEqual(await bound({}), { text: "ok" });
  });

  it("recognizes the metadata-only registration mode", () => {
    assert.equal(isCliMetadataRegistration({ registrationMode: "cli-metadata" }), true);
    assert.equal(isCliMetadataRegistration({ registrationMode: "full" }), false);
    assert.equal(isCliMetadataRegistration({}), false);
  });
});

describe("register() under cli-metadata registration", () => {
  let workDir;

  beforeEach(() => {
    resetRegistration();
    workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-cli-metadata-"));
  });

  afterEach(() => {
    resetRegistration();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("registers the CLI tree without touching the runtime or wiring the LLM client", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir, { smartExtraction: true }),
      registrationMode: "cli-metadata",
      runtime: createThrowingRuntime(),
    });

    memoryLanceDBProPlugin.register(harness.api);

    const messages = harness.logs.map(([, message]) => message);
    assert.ok(!messages.some((m) => m.includes("smart extraction init failed")), messages.join("\n"));
    assert.ok(!messages.some((m) => m.includes("intentionally unavailable")), messages.join("\n"));
    assert.equal(harness.cliRegistrations.length, 1, "one root CLI registration");
    const { opts } = harness.cliRegistrations[0];
    assert.deepEqual(opts.commands, ["memory-pro"]);
    assert.equal(opts.descriptors?.[0]?.name, "memory-pro");
    assert.equal(opts.descriptors?.[0]?.hasSubcommands, true);
  });

  it("rebuilds the runtime wiring when a full registration follows a metadata pass in one process", () => {
    const metadata = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir, { smartExtraction: true }),
      registrationMode: "cli-metadata",
      runtime: createThrowingRuntime(),
    });
    memoryLanceDBProPlugin.register(metadata.api);
    const metadataMessages = metadata.logs.map(([, message]) => message);
    assert.ok(!metadataMessages.some((m) => m.includes("admission control constructed")), metadataMessages.join("\n"));

    const full = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir, { smartExtraction: false, admissionControl: { enabled: true } }),
      registrationMode: "full",
      runtime: { llm: { complete: async () => ({ text: "{}" }) } },
    });
    memoryLanceDBProPlugin.register(full.api);
    const fullMessages = full.logs.map(([, message]) => message);
    assert.ok(
      fullMessages.some((m) => m.includes("admission control constructed for capture fallbacks")),
      "the runtime registration must not inherit the metadata pass's unwired singleton:\n" + fullMessages.join("\n"),
    );
    assert.ok(!fullMessages.some((m) => m.includes("init failed")), fullMessages.join("\n"));
  });

  it("keeps the full registration wiring intact", () => {
    const harness = createPluginApiHarness({
      resolveRoot: workDir,
      pluginConfig: makePluginConfig(workDir, { smartExtraction: false, admissionControl: { enabled: true } }),
      registrationMode: "full",
      runtime: { llm: { complete: async () => ({ text: "{}" }) } },
    });

    memoryLanceDBProPlugin.register(harness.api);

    const messages = harness.logs.map(([, message]) => message);
    assert.ok(
      messages.some((m) => m.includes("admission control constructed for capture fallbacks")),
      messages.join("\n"),
    );
    assert.ok(!messages.some((m) => m.includes("init failed")), messages.join("\n"));
  });
});

describe("manifest root command declaration", () => {
  it("declares the memory-pro root command with the same descriptor the registrar uses", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(Array.isArray(manifest.cliCommands), "manifest.cliCommands must be declared");
    const declared = manifest.cliCommands.find((entry) => entry.name === "memory-pro");
    assert.deepEqual(declared, { ...MEMORY_PRO_CLI_DESCRIPTOR });
  });
});
