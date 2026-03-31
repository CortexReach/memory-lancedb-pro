import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { Command } from "commander";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryCLI } = jiti("../cli.ts");

const ENV_KEYS = [
  "MEMORY_PRO_OAUTH_AUTHORIZE_URL",
  "MEMORY_PRO_OAUTH_TOKEN_URL",
  "MEMORY_PRO_OAUTH_REDIRECT_URI",
  "MEMORY_PRO_OAUTH_CLIENT_ID",
  "OPENCLAW_HOME",
];

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(accountId) {
  return [
    encodeSegment({ alg: "none", typ: "JWT" }),
    encodeSegment({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
    "signature",
  ].join(".");
}

function getBackupPath(oauthPath) {
  const parsed = path.parse(oauthPath);
  const fileName = parsed.ext
    ? `${parsed.name}.llm-backup${parsed.ext}`
    : `${parsed.base}.llm-backup.json`;
  return path.join(parsed.dir, fileName);
}

describe("memory-pro auth", () => {
  let tempDir;
  let server;
  let originalEnv;
  let originalCwd;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "memory-cli-oauth-"));
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips a dedicated llm api-key config through OAuth login/logout", async () => {
    const authCode = "test-auth-code";
    const accountId = "acct_cli_123";
    const redirectPort = 18765;
    let tokenRequests = 0;

    server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/oauth/token") {
        res.writeHead(404).end();
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      tokenRequests += 1;

      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), authCode);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: makeJwt(accountId),
        refresh_token: "refresh-cli-token",
        expires_in: 3600,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenPort = server.address().port;

    process.env.MEMORY_PRO_OAUTH_AUTHORIZE_URL = `http://127.0.0.1:${tokenPort}/oauth/authorize`;
    process.env.MEMORY_PRO_OAUTH_TOKEN_URL = `http://127.0.0.1:${tokenPort}/oauth/token`;
    process.env.MEMORY_PRO_OAUTH_REDIRECT_URI = `http://localhost:${redirectPort}/auth/callback`;
    process.env.MEMORY_PRO_OAUTH_CLIENT_ID = "test-client-id";

    const configPath = path.join(tempDir, "openclaw.json");
    const oauthPath = path.join(tempDir, ".memory-lancedb-pro", "oauth.json");
    const backupPath = getBackupPath(oauthPath);
    const originalLlmConfig = {
      auth: "api-key",
      apiKey: "old-llm-key",
      model: "gpt-4o-mini",
      baseURL: "https://api.openai.com/v1",
      timeoutMs: 45000,
    };
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              embedding: {
                provider: "openai-compatible",
                apiKey: "embed-key",
              },
              llm: originalLlmConfig,
            },
          },
        },
      },
    }, null, 2));

    let capturedAuthorizeUrl = "";
    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {} ,
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
      pluginConfig: {
        llm: {
          model: "openai/gpt-5.4",
        },
      },
      oauthTestHooks: {
        authorizeUrl: async (url) => {
          capturedAuthorizeUrl = url;
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state");
          setTimeout(() => {
            const callback = new URL(process.env.MEMORY_PRO_OAUTH_REDIRECT_URI);
            callback.searchParams.set("code", authCode);
            callback.searchParams.set("state", state || "");
            http.get(callback);
          }, 25);
        },
      },
    })({ program });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "auth",
        "login",
        "--config",
        configPath,
        "--provider",
        "openai-codex",
        "--oauth-path",
        oauthPath,
        "--model",
        "openai/gpt-5.4",
        "--no-browser",
      ]);
    } finally {
      console.log = originalLog;
    }

    assert.equal(tokenRequests, 1);
    assert.ok(capturedAuthorizeUrl.includes("client_id=test-client-id"));
    assert.ok(readFileSync(oauthPath, "utf8").includes(accountId));

    const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = updatedConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.equal(pluginConfig.llm.auth, "oauth");
    assert.equal(pluginConfig.llm.oauthProvider, "openai-codex");
    assert.equal(pluginConfig.llm.oauthPath, oauthPath);
    assert.equal(pluginConfig.llm.model, "gpt-5.4");
    assert.equal(pluginConfig.llm.timeoutMs, 45000);
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.llm, "apiKey"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.llm, "baseURL"), false);

    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.equal(backup.hadLlmConfig, true);
    assert.deepEqual(backup.llm, originalLlmConfig);

    const output = logs.join("\n");
    assert.match(output, /Provider: OpenAI Codex \(openai-codex,/);
    assert.match(output, /Authorization URL:/);
    assert.match(output, /OAuth login completed/);
    assert.match(output, /Updated memory-lancedb-pro config: llm.auth=oauth, llm.oauthProvider=openai-codex/);

    const logoutProgram = new Command();
    logoutProgram.exitOverride();
    createMemoryCLI({
      store: {},
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
    })({ program: logoutProgram });

    const logoutLogs = [];
    console.log = (...args) => logoutLogs.push(args.join(" "));
    try {
      await logoutProgram.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "auth",
        "logout",
        "--config",
        configPath,
      ]);
    } finally {
      console.log = originalLog;
    }

    assert.equal(existsSync(oauthPath), false);
    assert.equal(existsSync(backupPath), false);

    const restoredConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const restoredPluginConfig = restoredConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.deepEqual(restoredPluginConfig.llm, originalLlmConfig);

    const logoutOutput = logoutLogs.join("\n");
    assert.match(logoutOutput, /Updated memory-lancedb-pro config: llm.auth=api-key/);
  });

  it("supports interactive provider selection when --provider is omitted", async () => {
    const authCode = "test-auth-code";
    const accountId = "acct_cli_prompt_123";
    const redirectPort = 18766;

    server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/oauth/token") {
        res.writeHead(404).end();
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);

      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), authCode);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: makeJwt(accountId),
        refresh_token: "refresh-cli-token",
        expires_in: 3600,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenPort = server.address().port;

    process.env.MEMORY_PRO_OAUTH_AUTHORIZE_URL = `http://127.0.0.1:${tokenPort}/oauth/authorize`;
    process.env.MEMORY_PRO_OAUTH_TOKEN_URL = `http://127.0.0.1:${tokenPort}/oauth/token`;
    process.env.MEMORY_PRO_OAUTH_REDIRECT_URI = `http://localhost:${redirectPort}/auth/callback`;
    process.env.MEMORY_PRO_OAUTH_CLIENT_ID = "test-client-id";

    const configPath = path.join(tempDir, "openclaw.json");
    const oauthPath = path.join(tempDir, ".memory-lancedb-pro", "oauth.json");
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              embedding: {
                provider: "openai-compatible",
                apiKey: "embed-key",
              },
            },
          },
        },
      },
    }, null, 2));

    const selectedProviders = [];
    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {} ,
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
      oauthTestHooks: {
        chooseProvider: async (providers, currentProviderId) => {
          selectedProviders.push(currentProviderId);
          selectedProviders.push(...providers.map((provider) => provider.id));
          return "openai-codex";
        },
        authorizeUrl: async (url) => {
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state");
          setTimeout(() => {
            const callback = new URL(process.env.MEMORY_PRO_OAUTH_REDIRECT_URI);
            callback.searchParams.set("code", authCode);
            callback.searchParams.set("state", state || "");
            http.get(callback);
          }, 25);
        },
      },
    })({ program });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "auth",
        "login",
        "--config",
        configPath,
        "--oauth-path",
        oauthPath,
        "--model",
        "openai/gpt-5.4",
        "--no-browser",
      ]);
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(selectedProviders, ["openai-codex", "openai-codex"]);

    const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = updatedConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.equal(pluginConfig.llm.oauthProvider, "openai-codex");

    const output = logs.join("\n");
    assert.match(output, /Provider: OpenAI Codex \(openai-codex, prompt\)/);
  });

  it("defaults the OAuth file to the plugin-scoped path under OPENCLAW_HOME", async () => {
    const authCode = "test-auth-code";
    const accountId = "acct_cli_default_path_123";
    const redirectPort = 18767;

    server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/oauth/token") {
        res.writeHead(404).end();
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);

      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("code"), authCode);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: makeJwt(accountId),
        refresh_token: "refresh-cli-token",
        expires_in: 3600,
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenPort = server.address().port;

    process.env.MEMORY_PRO_OAUTH_AUTHORIZE_URL = `http://127.0.0.1:${tokenPort}/oauth/authorize`;
    process.env.MEMORY_PRO_OAUTH_TOKEN_URL = `http://127.0.0.1:${tokenPort}/oauth/token`;
    process.env.MEMORY_PRO_OAUTH_REDIRECT_URI = `http://localhost:${redirectPort}/auth/callback`;
    process.env.MEMORY_PRO_OAUTH_CLIENT_ID = "test-client-id";
    process.env.OPENCLAW_HOME = path.join(tempDir, "openclaw-home");

    const configPath = path.join(tempDir, "openclaw.json");
    const oauthPath = path.join(process.env.OPENCLAW_HOME, ".memory-lancedb-pro", "oauth.json");
    const backupPath = getBackupPath(oauthPath);
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              embedding: {
                provider: "openai-compatible",
                apiKey: "embed-key",
              },
            },
          },
        },
      },
    }, null, 2));

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {},
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
      oauthTestHooks: {
        authorizeUrl: async (url) => {
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state");
          setTimeout(() => {
            const callback = new URL(process.env.MEMORY_PRO_OAUTH_REDIRECT_URI);
            callback.searchParams.set("code", authCode);
            callback.searchParams.set("state", state || "");
            http.get(callback);
          }, 25);
        },
      },
    })({ program });

    await program.parseAsync([
      "node",
      "openclaw",
      "memory-pro",
      "auth",
      "login",
      "--config",
      configPath,
      "--provider",
      "openai-codex",
      "--model",
      "openai/gpt-5.4",
      "--no-browser",
    ]);

    assert.equal(existsSync(oauthPath), true);
    assert.equal(existsSync(backupPath), true);

    const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = updatedConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.equal(pluginConfig.llm.oauthPath, oauthPath);
  });

  it("resolves stored relative oauthPath against the config location during logout", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const otherDir = path.join(tempDir, "other");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });

    const configPath = path.join(workspaceDir, "openclaw.json");
    const storedOauthPath = ".memory-lancedb-pro/oauth.json";
    const actualOauthPath = path.join(workspaceDir, ".memory-lancedb-pro", "oauth.json");
    mkdirSync(path.dirname(actualOauthPath), { recursive: true });
    writeFileSync(actualOauthPath, JSON.stringify({ access_token: "token" }), "utf8");
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              llm: {
                auth: "oauth",
                oauthPath: storedOauthPath,
                baseURL: "https://chatgpt-proxy.example/v1",
              },
            },
          },
        },
      },
    }, null, 2));

    process.chdir(otherDir);

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {},
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
    })({ program });

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "auth",
        "logout",
        "--config",
        configPath,
      ]);
    } finally {
      console.log = originalLog;
    }

    assert.equal(existsSync(actualOauthPath), false);

    const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = updatedConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.equal(pluginConfig.llm.baseURL, "https://chatgpt-proxy.example/v1");
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.llm, "oauthPath"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.llm, "oauthProvider"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.llm, "auth"), false);

    const output = logs.join("\n");
    assert.match(output, new RegExp(`Deleted OAuth file: ${actualOauthPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("removes llm config on logout when only OAuth-generated fields remain and no backup exists", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    const configPath = path.join(workspaceDir, "openclaw.json");
    const oauthPath = path.join(workspaceDir, ".memory-lancedb-pro", "oauth.json");
    mkdirSync(path.dirname(oauthPath), { recursive: true });
    writeFileSync(oauthPath, JSON.stringify({ access_token: "token" }), "utf8");
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          "memory-lancedb-pro": {
            enabled: true,
            config: {
              llm: {
                auth: "oauth",
                oauthProvider: "openai-codex",
                oauthPath,
                model: "gpt-5.4",
              },
            },
          },
        },
      },
    }, null, 2));

    const program = new Command();
    program.exitOverride();
    createMemoryCLI({
      store: {},
      retriever: {},
      scopeManager: {},
      migrator: {},
      pluginId: "memory-lancedb-pro",
    })({ program });

    await program.parseAsync([
      "node",
      "openclaw",
      "memory-pro",
      "auth",
      "logout",
      "--config",
      configPath,
    ]);

    const updatedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const pluginConfig = updatedConfig.plugins.entries["memory-lancedb-pro"].config;
    assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig, "llm"), false);
  });
});
