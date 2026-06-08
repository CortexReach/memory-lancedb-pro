import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");
const resetRegistration = plugin.resetRegistration ?? (() => {});

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function createMockApi(pluginConfig, options = {}) {
  return {
    pluginConfig,
    hooks: {},
    toolFactories: {},
    memoryCapability: null,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    resolvePath(value) {
      return value;
    },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService(service) {
      options.services?.push(service);
    },
    registerMemoryCapability(capability) {
      this.memoryCapability = capability;
    },
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

for (const key of [
  "smartExtraction",
  "extractMinMessages",
  "extractMaxChars",
  "llm",
  "autoRecallMaxItems",
  "autoRecallMaxChars",
  "autoRecallPerItemMaxChars",
]) {
  assert.ok(
    Object.prototype.hasOwnProperty.call(manifest.configSchema.properties, key),
    `configSchema should declare ${key}`,
  );
}

assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties.llm.properties, "auth"),
  "configSchema should declare llm.auth",
);
for (const toolName of ["memory_recall", "memory_search", "memory_get", "memory_store"]) {
  assert.ok(
    manifest.contracts.tools.includes(toolName),
    `contracts.tools should declare ${toolName}`,
  );
}
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties.llm.properties, "oauthPath"),
  "configSchema should declare llm.oauthPath",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties.llm.properties, "oauthProvider"),
  "configSchema should declare llm.oauthProvider",
);

assert.equal(
  manifest.configSchema.properties.autoRecallMinRepeated.default,
  8,
  "autoRecallMinRepeated schema default should be conservative",
);
assert.equal(
  manifest.configSchema.properties.extractMinMessages.default,
  4,
  "extractMinMessages schema default should reduce aggressive auto-capture",
);
assert.equal(
  manifest.configSchema.properties.autoCapture.default,
  true,
  "autoCapture schema default should match runtime default",
);
assert.equal(
  manifest.configSchema.properties.embedding.properties.chunking.default,
  true,
  "embedding.chunking schema default should match runtime default",
);
assert.ok(
  !(manifest.configSchema.required ?? []).includes("embedding"),
  "root configSchema should not require embedding because OpenClaw preflight validates undefined plugin config as {} before runtime parsePluginConfig can emit the clearer activation error",
);
assert.ok(
  manifest.configSchema.properties.embedding.required.includes("apiKey"),
  "embedding.apiKey should remain schema-required when an embedding block is supplied",
);
assert.equal(
  manifest.configSchema.properties.embedding.properties.omitDimensions?.type,
  "boolean",
  "embedding.omitDimensions should be declared in the plugin schema",
);
assert.equal(
  manifest.configSchema.properties.embedding.properties.requestDimensions?.type,
  "integer",
  "embedding.requestDimensions should be declared in the plugin schema",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.uiHints, "embedding.requestDimensions"),
  "uiHints should expose embedding.requestDimensions",
);
assert.equal(
  manifest.configSchema.properties.sessionMemory.properties.enabled.default,
  false,
  "sessionMemory.enabled schema default should match runtime default",
);
assert.ok(
  manifest.configSchema.properties.retrieval.properties.rerankProvider.enum.includes("tei"),
  "rerankProvider schema should include tei",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties, "dreaming"),
  "configSchema should declare dreaming so the plugin can own the OpenClaw memory slot",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties, "canonicalCorpus"),
  "configSchema should declare canonicalCorpus for file-backed memory indexing",
);
assert.equal(
  manifest.configSchema.properties.canonicalCorpus.properties.includeSessionTranscripts.default,
  true,
  "canonical corpus should index session transcripts by default",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.uiHints, "canonicalCorpus.enabled"),
  "uiHints should expose canonical corpus ownership",
);
assert.equal(
  manifest.configSchema.properties.dreaming.additionalProperties,
  false,
  "dreaming schema should reject unknown keys consistently with memory-core",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(manifest.configSchema.properties.dreaming.properties, "phases"),
  "dreaming schema should declare phase config",
);
assert.ok(
  Object.prototype.hasOwnProperty.call(
    manifest.configSchema.properties.dreaming.properties.execution.properties.defaults.properties,
    "speed",
  ),
  "dreaming execution defaults should expose memory-core speed/thinking/budget knobs",
);
assert.ok(
  manifest.configSchema.properties.dreaming.properties.phases.properties.deep.properties.sources.items.enum.includes("logs"),
  "deep dreaming sources should accept memory-core log source",
);
assert.ok(
  (manifest.commandAliases ?? []).some((entry) => entry?.name === "dreaming"),
  "manifest should expose the dreaming runtime slash command alias while owning the memory slot",
);

assert.equal(
  manifest.version,
  pkg.version,
  "openclaw.plugin.json version should stay aligned with package.json",
);
assert.equal(
  manifest.hooks?.allowConversationAccess,
  true,
  "openclaw.plugin.json should declare conversation hook access for non-bundled OpenClaw plugins",
);
assert.equal(
  pkg.dependencies["apache-arrow"],
  "18.1.0",
  "package.json should declare apache-arrow directly so OpenClaw plugin installs do not miss the LanceDB runtime dependency",
);

const workDir = mkdtempSync(path.join(tmpdir(), "memory-plugin-regression-"));
const services = [];
const embeddingRequests = [];

try {
  const startupDbPath = path.join(workDir, "db");
  const api = createMockApi(
    {
      dbPath: startupDbPath,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: "http://127.0.0.1:9/v1",
        dimensions: 1536,
      },
    },
    { services },
  );
  resetRegistration();
  assert.equal(existsSync(startupDbPath), false, "test dbPath should start missing");
  plugin.register(api);
  assert.equal(
    existsSync(startupDbPath),
    false,
    "plugin registration should not synchronously create or validate dbPath",
  );
  assert.equal(
    typeof api.memoryCapability?.runtime?.getMemorySearchManager,
    "function",
    "plugin should register an OpenClaw memory capability runtime",
  );
  for (const toolName of ["memory_recall", "memory_search", "memory_get"]) {
    assert.equal(
      typeof api.toolFactories[toolName],
      "function",
      `plugin should register ${toolName}`,
    );
  }
  assert.equal(
    typeof api.memoryCapability?.promptBuilder,
    "function",
    "plugin should register an OpenClaw memory prompt builder",
  );
  assert.equal(
    typeof api.memoryCapability?.flushPlanResolver,
    "function",
    "plugin should register an OpenClaw memory flush plan resolver",
  );
  assert.equal(
    typeof api.memoryCapability?.publicArtifacts?.listArtifacts,
    "function",
    "plugin should register an OpenClaw public artifacts provider",
  );
  const promptLines = api.memoryCapability.promptBuilder({
    availableTools: new Set(["memory_recall", "memory_store"]),
  });
  assert.ok(
    promptLines.some((line) => /Memory Recall/.test(line)),
    "memory prompt builder should provide recall guidance",
  );
  const flushPlan = api.memoryCapability.flushPlanResolver({
    cfg: { agents: { defaults: { userTimezone: "UTC" } } },
    nowMs: Date.UTC(2026, 4, 23),
  });
  assert.equal(
    flushPlan.relativePath,
    "memory/2026-05-23.md",
    "memory flush plan should target canonical daily memory files",
  );
  const { manager } = await api.memoryCapability.runtime.getMemorySearchManager({
    cfg: {},
    agentId: "main",
  });
  assert.equal(
    manager.status().provider,
    "memory-lancedb-pro",
    "memory capability runtime status should identify this provider",
  );
  assert.equal(services.length, 1, "plugin should register its background service");
  assert.equal(typeof api.hooks.agent_end, "function", "autoCapture should remain enabled by default");
  assert.equal(api.hooks["command:new"], undefined, "selfImprovement command:new hook should stay disabled without selfImprovement config (#405)");
  await assert.doesNotReject(
    services[0].stop(),
    "service stop should not throw when no access tracker is configured",
  );

  const sessionDefaultApi = createMockApi({
    dbPath: path.join(workDir, "db-session-default"),
    autoCapture: false,
    autoRecall: false,
    sessionMemory: {},
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
  });
  resetRegistration();
  plugin.register(sessionDefaultApi);
  assert.equal(
    sessionDefaultApi.hooks["command:new"],
    undefined,
    "sessionMemory config should not implicitly enable selfImprovement command:new hook (#405)",
  );

  const sessionEnabledApi = createMockApi({
    dbPath: path.join(workDir, "db-session-enabled"),
    autoCapture: false,
    autoRecall: false,
    sessionMemory: { enabled: true },
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
  });
  resetRegistration();
  plugin.register(sessionEnabledApi);
  assert.equal(
    typeof sessionEnabledApi.hooks.before_reset,
    "function",
    "sessionMemory.enabled=true should register the async before_reset hook",
  );
  assert.equal(
    sessionEnabledApi.hooks["command:new"],
    undefined,
    "sessionMemory.enabled=true should not implicitly enable selfImprovement command:new hook (#405)",
  );

  const selfImprovementEnabledApi = createMockApi({
    dbPath: path.join(workDir, "db-self-improvement-enabled"),
    autoCapture: false,
    autoRecall: false,
    sessionStrategy: "none",
    selfImprovement: {
      enabled: true,
      ensureLearningFiles: false,
    },
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
  });
  resetRegistration();
  plugin.register(selfImprovementEnabledApi);
  assert.equal(
    typeof selfImprovementEnabledApi.hooks["command:new"],
    "function",
    "selfImprovement.enabled=true should register command:new hook (#405)",
  );

  const longText = `${"Long embedding payload. ".repeat(420)}tail`;
  const threshold = 6000;
  const embeddingServer = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    embeddingRequests.push(payload);
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

    if (inputs.some((input) => String(input).length > threshold)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "context length exceeded for mock embedding endpoint",
          type: "invalid_request_error",
        },
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((_, index) => ({
        object: "embedding",
        index,
        embedding: [0.5, 0.5, 0.5, 0.5],
      })),
      model: payload.model || "mock-embedding-model",
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    }));
  });

  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  const embeddingPort = embeddingServer.address().port;
  const embeddingBaseURL = `http://127.0.0.1:${embeddingPort}/v1`;

  try {
    const chunkingOffApi = createMockApi({
      dbPath: path.join(workDir, "db-chunking-off"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
        chunking: false,
      },
    });
    resetRegistration();
    plugin.register(chunkingOffApi);
    const chunkingOffTool = chunkingOffApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const chunkingOffResult = await chunkingOffTool.execute("tool-1", {
      text: longText,
      scope: "global",
    });
    assert.equal(
      chunkingOffResult.details.error,
      "store_failed",
      "embedding.chunking=false should let long-document embedding fail",
    );

    const chunkingOnApi = createMockApi({
      dbPath: path.join(workDir, "db-chunking-on"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
        chunking: true,
      },
    });
    resetRegistration();
    plugin.register(chunkingOnApi);
    const chunkingOnTool = chunkingOnApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const chunkingOnResult = await chunkingOnTool.execute("tool-2", {
      text: longText,
      scope: "global",
    });
    assert.equal(
      chunkingOnResult.details.action,
      "created",
      "embedding.chunking=true should recover from long-document embedding errors",
    );

    const withDimensionsApi = createMockApi({
      dbPath: path.join(workDir, "db-with-dimensions"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
      },
    });
    resetRegistration();
    plugin.register(withDimensionsApi);
    const withDimensionsTool = withDimensionsApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeWithDimensions = embeddingRequests.length;
    await withDimensionsTool.execute("tool-3", {
      text: "dimensions should stay internal by default",
      scope: "global",
    });
    const withDimensionsRequest = embeddingRequests.at(requestCountBeforeWithDimensions);
    assert.equal(
      Object.prototype.hasOwnProperty.call(withDimensionsRequest ?? {}, "dimensions"),
      false,
      "embedding.dimensions should be used for local schema sizing, not forwarded by default",
    );

    const withRequestDimensionsApi = createMockApi({
      dbPath: path.join(workDir, "db-with-request-dimensions"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        requestDimensions: 4,
      },
    });
    resetRegistration();
    plugin.register(withRequestDimensionsApi);
    const withRequestDimensionsTool = withRequestDimensionsApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeRequestDimensions = embeddingRequests.length;
    const withRequestDimensionsResult = await withRequestDimensionsTool.execute("tool-3b", {
      text: "requestDimensions should drive both request payload and local schema size",
      scope: "global",
    });
    assert.equal(
      withRequestDimensionsResult.details.action,
      "created",
      "requestDimensions-only config should still create memories end-to-end",
    );
    const withRequestDimensionsRequest = embeddingRequests.at(requestCountBeforeRequestDimensions);
    assert.equal(
      withRequestDimensionsRequest?.dimensions,
      4,
      "embedding.requestDimensions should be forwarded to embedding requests",
    );

    const omitDimensionsApi = createMockApi({
      dbPath: path.join(workDir, "db-omit-dimensions"),
      autoCapture: false,
      autoRecall: false,
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        requestDimensions: 4,
        omitDimensions: true,
      },
    });
    resetRegistration();
    plugin.register(omitDimensionsApi);
    const omitDimensionsTool = omitDimensionsApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeOmitDimensions = embeddingRequests.length;
    await omitDimensionsTool.execute("tool-4", {
      text: "dimensions should be omitted when configured",
      scope: "global",
    });
    const omitDimensionsRequest = embeddingRequests.at(requestCountBeforeOmitDimensions);
    assert.equal(
      Object.prototype.hasOwnProperty.call(omitDimensionsRequest, "dimensions"),
      false,
      "embedding.omitDimensions=true should omit dimensions from embedding requests even when requestDimensions is set",
    );
  } finally {
    await new Promise((resolve) => embeddingServer.close(resolve));
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: plugin manifest regression test passed");
