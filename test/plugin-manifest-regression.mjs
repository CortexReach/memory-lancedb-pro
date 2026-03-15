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

for (const key of ["smartExtraction", "extractMinMessages", "extractMaxChars", "llm"]) {
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

try {
  const api = createMockApi(
    {
      dbPath: path.join(workDir, "db"),
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
  plugin.register(api);
  assert.equal(services.length, 1, "plugin should register its background service");
  assert.equal(typeof api.hooks.agent_end, "function", "autoCapture should remain enabled by default");
  assert.equal(api.hooks["command:new"], undefined, "sessionMemory should stay disabled by default");
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
  plugin.register(sessionDefaultApi);
  assert.equal(
    sessionDefaultApi.hooks["command:new"],
    undefined,
    "sessionMemory:{} should not implicitly enable the /new hook",
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
  plugin.register(sessionEnabledApi);
  assert.equal(
    typeof sessionEnabledApi.hooks["command:new"],
    "function",
    "sessionMemory.enabled=true should register the /new hook",
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
  } finally {
    await new Promise((resolve) => embeddingServer.close(resolve));
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: plugin manifest regression test passed");
