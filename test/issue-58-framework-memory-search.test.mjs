import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");

function createMockApi(pluginConfig, openClawConfig = {}) {
  return {
    config: openClawConfig,
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
    registerService() {},
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

async function withEmbeddingServer(run) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404);
      res.end();
      return;
    }

    requests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await run({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      getRequests: () => requests,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runAutoRecallScenario(openClawConfig) {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-issue-58-"));

  try {
    return await withEmbeddingServer(async ({ baseURL, getRequests }) => {
      const api = createMockApi(
        {
          dbPath: path.join(workDir, "db"),
          autoCapture: false,
          autoRecall: true,
          embedding: {
            provider: "openai-compatible",
            apiKey: "dummy",
            model: "text-embedding-3-small",
            baseURL,
            dimensions: 4,
          },
        },
        openClawConfig,
      );

      plugin.register(api);
      assert.equal(
        typeof api.hooks.before_agent_start,
        "function",
        "autoRecall=true should register the before_agent_start hook",
      );

      const result = await api.hooks.before_agent_start(
        {
          prompt: "Remember that I prefer oolong tea over coffee.",
        },
        {
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:test",
        },
      );

      return {
        result,
        requests: getRequests(),
      };
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("issue #58: defaults memorySearch.enabled=false skips auto-recall", async () => {
  const outcome = await runAutoRecallScenario({
    agents: {
      defaults: {
        memorySearch: {
          enabled: false,
        },
      },
    },
  });

  assert.equal(outcome.result, undefined);
  assert.equal(outcome.requests, 0);
});

test("issue #58: agent-level enabled=true overrides defaults false and allows recall", async () => {
  const outcome = await runAutoRecallScenario({
    agents: {
      defaults: {
        memorySearch: {
          enabled: false,
        },
      },
      list: [
        {
          id: "main",
          memorySearch: {
            enabled: true,
          },
        },
      ],
    },
  });

  assert.ok(outcome.requests > 0);
});

test("issue #58: agent-level enabled=false overrides defaults true and skips recall", async () => {
  const outcome = await runAutoRecallScenario({
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
        },
      },
      list: [
        {
          id: "main",
          memorySearch: {
            enabled: false,
          },
        },
      ],
    },
  });

  assert.equal(outcome.result, undefined);
  assert.equal(outcome.requests, 0);
});
