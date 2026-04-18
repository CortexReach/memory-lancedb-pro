import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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
assert.equal(
  manifest.configSchema.properties.embedding.properties.omitDimensions?.type,
  "boolean",
  "embedding.omitDimensions should be declared in the plugin schema",
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

assert.equal(
  manifest.version,
  pkg.version,
  "openclaw.plugin.json version should stay aligned with package.json",
);
assert.equal(
  pkg.dependencies["apache-arrow"],
  "18.1.0",
  "package.json should declare apache-arrow directly so OpenClaw plugin installs do not miss the LanceDB runtime dependency",
);

const workDir = mkdtempSync(path.join(tmpdir(), "memory-plugin-regression-"));
const services = [];
const embeddingRequests = [];

// Start embedding mock server BEFORE the first plugin.register() call so the
// singleton's embedder is configured with a working baseURL. The singleton
// state (PR #598) is initialised once on the first register() call and reused
// by all subsequent calls, so the embedding endpoint must be reachable from
// the very first registration.
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
  const api = createMockApi(
    {
      dbPath: path.join(workDir, "db"),
      autoRecall: false,
      sessionMemory: { enabled: true },
      embedding: {
        provider: "openai-compatible",
        apiKey: "dummy",
        model: "text-embedding-3-small",
        baseURL: embeddingBaseURL,
        dimensions: 4,
      },
    },
    { services },
  );
  plugin.register(api);
  assert.equal(services.length, 1, "plugin should register its background service");
  assert.equal(typeof api.hooks.agent_end, "function", "autoCapture should remain enabled by default");
  assert.equal(typeof api.hooks["command:new"], "function", "selfImprovement command:new hook should be registered by default (#391)");
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
      baseURL: embeddingBaseURL,
      dimensions: 4,
    },
  });
  plugin.register(sessionDefaultApi);
  // selfImprovement registers command:new by default (#391), independent of sessionMemory config
  assert.equal(
    typeof sessionDefaultApi.hooks["command:new"],
    "function",
    "command:new hook should be registered (selfImprovement default-on since #391)",
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
      baseURL: embeddingBaseURL,
      dimensions: 4,
    },
  });
  plugin.register(sessionEnabledApi);
  assert.equal(
    typeof sessionEnabledApi.hooks.before_reset,
    "function",
    "sessionMemory.enabled=true should register the async before_reset hook",
  );
  // selfImprovement registers command:new by default (#391), independent of sessionMemory config
  assert.equal(
    typeof sessionEnabledApi.hooks["command:new"],
    "function",
    "command:new hook should be registered (selfImprovement default-on since #391)",
  );

  {
    // After PR #598 (Singleton State Management), the embedder is initialised
    // once on the first register() call.  Per-registration chunking overrides
    // are no longer honoured — the singleton's chunking setting (default: true)
    // applies to every tool instance.  We therefore test the singleton's
    // chunking behaviour once: a long document should be automatically chunked
    // and stored successfully.
    const chunkingApi = createMockApi({
      dbPath: path.join(workDir, "db-chunking"),
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
    plugin.register(chunkingApi);
    const chunkingTool = chunkingApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const chunkingResult = await chunkingTool.execute("tool-1", {
      text: longText,
      scope: "global",
    });
    assert.equal(
      chunkingResult.details.action,
      "created",
      "singleton embedder (chunking=true by default) should recover from long-document embedding errors",
    );

    // After PR #598 (Singleton State Management), the embedder is initialised
    // once on the first register() call.  Verify that the singleton's
    // dimensions setting (4, from the first registration) is forwarded in
    // embedding requests.
    const dimensionsApi = createMockApi({
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
    plugin.register(dimensionsApi);
    const dimensionsTool = dimensionsApi.toolFactories.memory_store({
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const requestCountBeforeDimensions = embeddingRequests.length;
    await dimensionsTool.execute("tool-3", {
      text: "dimensions should be sent by default",
      scope: "global",
    });
    const dimensionsRequest = embeddingRequests.at(requestCountBeforeDimensions);
    assert.equal(
      dimensionsRequest?.dimensions,
      4,
      "embedding.dimensions should be forwarded by default",
    );
  }
} finally {
  await new Promise((resolve) => embeddingServer.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: plugin manifest regression test passed");
