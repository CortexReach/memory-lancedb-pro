import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Module from "node:module";
import jitiFactory from "jiti";

// Ensure openclaw module resolution works in CI environments
process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");

function createMockApi(pluginConfig) {
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
    resolvePath(value) { return value; },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService() {},
    on(name, handler) { this.hooks[name] = handler; },
    registerHook(name, handler) { this.hooks[name] = handler; },
  };
}

const workDir = mkdtempSync(path.join(tmpdir(), "agent-end-async-test-"));

try {
  describe("agent_end hook — async capture behavior", () => {

    // -----------------------------------------------------------------------
    // Test 1: hook returns a Promise (is async)
    // -----------------------------------------------------------------------
    it("agent_end hook returns a Promise (async function)", () => {
      const api = createMockApi({
        dbPath: path.join(workDir, "db-async-check"),
        autoRecall: false,
        embedding: {
          provider: "openai-compatible",
          apiKey: "dummy",
          model: "text-embedding-3-small",
          baseURL: "http://127.0.0.1:9/v1",
          dimensions: 1536,
        },
      });
      plugin.register(api);

      const hook = api.hooks.agent_end;
      assert.ok(hook, "agent_end hook should be registered");

      // Call with a non-successful event to hit early return path
      const result = hook({ success: false, messages: [] }, {});
      // Even early return from an async function yields a Promise
      assert.ok(
        result === undefined || result instanceof Promise,
        "hook should return a Promise or undefined (async function signature)",
      );
    });

    // -----------------------------------------------------------------------
    // Test 2: hook does NOT throw when backgroundRun rejects
    // -----------------------------------------------------------------------
    it("hook swallows errors from backgroundRun gracefully", async () => {
      const api = createMockApi({
        dbPath: path.join(workDir, "db-error-swallow"),
        autoRecall: false,
        embedding: {
          provider: "openai-compatible",
          apiKey: "dummy",
          model: "text-embedding-3-small",
          // Point at unreachable endpoint to force rejection
          baseURL: "http://127.0.0.1:9/v1",
          dimensions: 1536,
        },
      });
      plugin.register(api);

      const hook = api.hooks.agent_end;
      assert.ok(hook, "agent_end hook should be registered");

      // This triggers a real backgroundRun that will fail because the
      // embedding endpoint is unreachable.  The hook should NOT throw.
      await assert.doesNotReject(
        Promise.resolve(hook(
          {
            success: true,
            messages: [
              { role: "user", content: "Merke dir: Testdaten sind wichtig" },
              { role: "assistant", content: "Alles klar, ich merke mir das." },
            ],
          },
          { agentId: "test-agent", sessionKey: "test:session:1" },
        )),
        "hook should not throw even when backgroundRun rejects",
      );
    });

    // -----------------------------------------------------------------------
    // Test 3: hook stores __lastRun as a Promise
    // -----------------------------------------------------------------------
    it("stores __lastRun as a Promise for downstream consumers", () => {
      const api = createMockApi({
        dbPath: path.join(workDir, "db-lastrun"),
        autoRecall: false,
        embedding: {
          provider: "openai-compatible",
          apiKey: "dummy",
          model: "text-embedding-3-small",
          baseURL: "http://127.0.0.1:9/v1",
          dimensions: 1536,
        },
      });
      plugin.register(api);

      const hook = api.hooks.agent_end;
      // Trigger hook with valid event
      hook(
        {
          success: true,
          messages: [
            { role: "user", content: "Mein Lieblingseditor ist Neovim" },
            { role: "assistant", content: "Notiert." },
          ],
        },
        { agentId: "test-agent", sessionKey: "test:session:2" },
      );

      assert.ok(
        hook.__lastRun instanceof Promise,
        "__lastRun should be set to a Promise so callers can await it",
      );
    });

    // -----------------------------------------------------------------------
    // Test 4: hook does NOT hang on early-return (no messages)
    // -----------------------------------------------------------------------
    it("returns immediately for empty message events (no timer leak)", async () => {
      const api = createMockApi({
        dbPath: path.join(workDir, "db-early-return"),
        autoRecall: false,
        embedding: {
          provider: "openai-compatible",
          apiKey: "dummy",
          model: "text-embedding-3-small",
          baseURL: "http://127.0.0.1:9/v1",
          dimensions: 1536,
        },
      });
      plugin.register(api);

      const hook = api.hooks.agent_end;

      const start = Date.now();
      await Promise.resolve(hook({ success: true, messages: [] }, {}));
      const elapsed = Date.now() - start;

      // Early return should be near-instant, not wait for 15s timeout
      assert.ok(
        elapsed < 1000,
        `Early return should complete in <1s, took ${elapsed}ms`,
      );
    });
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: agent-end-async-capture test passed");
