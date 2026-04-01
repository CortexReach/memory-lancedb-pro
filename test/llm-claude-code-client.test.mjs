/**
 * Unit tests for the claude-code LLM client.
 * Covers: env sanitization, JSON extraction, error paths.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createLlmClient, buildClaudeCodeEnv, extractJsonFromResponse, repairCommonJson, extractTextFromSdkMessage } = jiti("../src/llm-client.ts");

// ---------------------------------------------------------------------------
// buildClaudeCodeEnv — env sanitization (most critical security logic)
// ---------------------------------------------------------------------------

describe("buildClaudeCodeEnv", () => {
  it("preserves ANTHROPIC_API_KEY when no explicit key provided (ambient auth)", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const env = buildClaudeCodeEnv(undefined);
      assert.equal(env.ANTHROPIC_API_KEY, "ambient-key", "should preserve ambient key when no explicit key");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("replaces ANTHROPIC_API_KEY when explicit key provided", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const env = buildClaudeCodeEnv("explicit-key");
      assert.equal(env.ANTHROPIC_API_KEY, "explicit-key", "explicit key should override ambient");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("always sets CLAUDE_CODE_ENTRYPOINT=sdk-ts", () => {
    const env = buildClaudeCodeEnv();
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  });

  it("strips CLAUDECODE (exact) to prevent nested-session errors", () => {
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDECODE, undefined, "CLAUDECODE should be stripped");
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
  });

  it("strips CLAUDECODE_* prefixed vars", () => {
    process.env.CLAUDECODE_SOME_VAR = "should-be-stripped";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDECODE_SOME_VAR, undefined);
    } finally {
      delete process.env.CLAUDECODE_SOME_VAR;
    }
  });

  it("strips CLAUDE_CODE_SESSION but preserves CLAUDE_CODE_OAUTH_TOKEN", () => {
    process.env.CLAUDE_CODE_SESSION = "strip-me";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "keep-me";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDE_CODE_SESSION, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "keep-me");
    } finally {
      delete process.env.CLAUDE_CODE_SESSION;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("logs warning when no auth source is present (uses empty settings mock)", () => {
    // Use settingsPathOverride pointing to /dev/null so no auth comes from settings.json,
    // making this test deterministic regardless of the dev machine's ~/.claude/settings.json.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const logs = [];
    // Pass a nonexistent path so settings.json loading is skipped (ENOENT → silent),
    // making the test deterministic regardless of the dev machine's ~/.claude/settings.json.
    buildClaudeCodeEnv(undefined, (msg) => logs.push(msg), undefined, "/tmp/memory-lancedb-pro-no-such-settings-test.json");
    assert.ok(logs.some(l => l.includes("no ANTHROPIC")), "should warn when no auth source");

    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    if (savedOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
  });

  it("routes no-auth warning to logWarn when provided (uses empty settings mock)", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const debugLogs = [];
    const warnLogs = [];
    // Pass a nonexistent path so settings.json loading is skipped (ENOENT → silent),
    // making the test deterministic regardless of the dev machine's ~/.claude/settings.json.
    buildClaudeCodeEnv(undefined, (msg) => debugLogs.push(msg), (msg) => warnLogs.push(msg), "/tmp/memory-lancedb-pro-no-such-settings-test.json");
    assert.ok(warnLogs.some(l => l.includes("no ANTHROPIC")), "warning should go to logWarn");
    assert.ok(!debugLogs.some(l => l.includes("no ANTHROPIC")), "warning should not go to debug log");

    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    if (savedOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
  });

  it("strips MCP_SESSION_ID", () => {
    process.env.MCP_SESSION_ID = "strip-me";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.MCP_SESSION_ID, undefined, "MCP_SESSION_ID should be stripped");
    } finally {
      delete process.env.MCP_SESSION_ID;
    }
  });

  it("preserves CLAUDE_CODE_GIT_BASH_PATH", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "/usr/bin/bash";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "/usr/bin/bash", "CLAUDE_CODE_GIT_BASH_PATH should be preserved");
    } finally {
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    }
  });

  it("does not warn when ANTHROPIC_AUTH_TOKEN is present (subscription auth)", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = "claude-subscription-token";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const warnLogs = [];
    buildClaudeCodeEnv(undefined, undefined, (msg) => warnLogs.push(msg));
    assert.ok(
      !warnLogs.some(l => l.includes("no ANTHROPIC")),
      "should not warn when ANTHROPIC_AUTH_TOKEN is present",
    );

    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
    if (savedOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
  });
});

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

describe("extractJsonFromResponse", () => {
  it("extracts plain JSON", () => {
    const raw = '{"memories":[{"text":"test","category":"fact"}]}';
    const jsonStr = extractJsonFromResponse(raw);
    assert.notEqual(jsonStr, null);
    assert.deepEqual(JSON.parse(jsonStr), { memories: [{ text: "test", category: "fact" }] });
  });

  it("handles markdown fences", () => {
    const raw = "Here is the result:\n```json\n{\"ok\":true}\n```";
    const jsonStr = extractJsonFromResponse(raw);
    assert.notEqual(jsonStr, null);
    assert.deepEqual(JSON.parse(jsonStr), { ok: true });
  });

  it("returns null for non-JSON text", () => {
    assert.equal(extractJsonFromResponse("no json here"), null);
  });
});

describe("repairCommonJson", () => {
  it("removes trailing commas", () => {
    const broken = '{"a":1,"b":2,}';
    assert.doesNotThrow(() => JSON.parse(repairCommonJson(broken)));
  });

  it("escapes unescaped newlines in strings", () => {
    const broken = '{"text":"line1\nline2"}';
    const repaired = repairCommonJson(broken);
    assert.doesNotThrow(() => JSON.parse(repaired));
  });
});

// ---------------------------------------------------------------------------
// createLlmClient — claude-code client instantiation
// ---------------------------------------------------------------------------

describe("createLlmClient claude-code", () => {
  it("returns a client with completeJson and getLastError functions", () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/tmp/test-state",
    });
    assert.equal(typeof llm.completeJson, "function");
    assert.equal(typeof llm.getLastError, "function");
    assert.equal(llm.getLastError(), null, "no error before any call");
  });

  it("returns null and sets lastError when claudeCodePath does not exist", async () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/tmp/test-state",
      claudeCodePath: "/nonexistent/path/to/claude",
    });
    const result = await llm.completeJson('{"test": true}', "test-label");
    assert.equal(result, null, "should return null when claude binary not found");
    const err = llm.getLastError();
    assert.ok(err !== null, "should set lastError");
    assert.ok(
      err.includes("not found") || err.includes("not installed") || err.includes("claude"),
      `lastError should describe the failure, got: ${err}`,
    );
  });

  it("caches claude path resolution failure — does not retry execSync on subsequent calls", async () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/tmp/test-state",
      claudeCodePath: "/nonexistent/path/to/claude-cached-test",
    });
    // First call triggers resolution failure
    const r1 = await llm.completeJson("prompt1", "label1");
    assert.equal(r1, null);
    const err1 = llm.getLastError();
    // Second call must also fail without re-running execSync
    const r2 = await llm.completeJson("prompt2", "label2");
    assert.equal(r2, null);
    const err2 = llm.getLastError();
    // Both errors should reference the same binary path issue
    assert.ok(err1 !== null && err2 !== null);
    assert.ok(
      err1.includes("nonexistent") || err1.includes("not found"),
      `first error should mention path, got: ${err1}`,
    );
  });

  it("includes system error reason in accessSync failure message", async () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/tmp/test-state",
      claudeCodePath: "/nonexistent/path/to/claude-reason-test",
    });
    await llm.completeJson("test", "label");
    const err = llm.getLastError();
    assert.ok(err !== null);
    // Error should include system error detail (ENOENT or similar), not just "not found or not executable"
    assert.ok(
      err.includes("not accessible") || err.includes("nonexistent"),
      `error should describe access failure with detail, got: ${err}`,
    );
  });

  it("routes client errors to logWarn and not log when both callbacks provided", async () => {
    const debugLogs = [];
    const warnLogs = [];
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/tmp/test-state",
      claudeCodePath: "/nonexistent/path/to/claude-logwarn-test",
      log: (msg) => debugLogs.push(msg),
      logWarn: (msg) => warnLogs.push(msg),
    });
    const result = await llm.completeJson("test", "label");
    assert.equal(result, null, "should fail for nonexistent path");
    assert.ok(warnLogs.length > 0, "error should be logged to logWarn");
    assert.equal(debugLogs.filter(m => m.includes("nonexistent") || m.includes("not accessible")).length, 0,
      "error should not appear in debug log when logWarn is provided");
  });
});


// ---------------------------------------------------------------------------
// createLlmClient — factory auth routing (early validation)
// ---------------------------------------------------------------------------

describe("createLlmClient factory auth validation", () => {
  it("throws synchronously when auth='api-key' and no apiKey provided", () => {
    assert.throws(
      () => createLlmClient({ auth: "api-key", model: "gpt-4" }),
      /api-key.*requires.*apiKey|requires.*apiKey/i,
    );
  });

  it("throws synchronously when auth='oauth' and no oauthPath provided", () => {
    assert.throws(
      () => createLlmClient({ auth: "oauth", model: "gpt-4" }),
      /oauth.*requires.*oauthPath|requires.*oauthPath/i,
    );
  });
});

// ---------------------------------------------------------------------------
// buildClaudeCodeEnv — settings.json loading (via override path)
// ---------------------------------------------------------------------------

describe("buildClaudeCodeEnv settings.json loading", () => {
  it("loads auth token from settings.json and uses it over ambient env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "from-settings" } }));

      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "from-ambient";
      try {
        const env = buildClaudeCodeEnv(undefined, undefined, undefined, settingsPath);
        // settings.json auth key takes precedence over ambient
        assert.equal(env.ANTHROPIC_API_KEY, "from-settings", "settings.json key should win over ambient");
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not inject strip-listed keys from settings.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_SESSION: "should-be-stripped" } }));
      const env = buildClaudeCodeEnv(undefined, undefined, undefined, settingsPath);
      assert.equal(env.CLAUDE_CODE_SESSION, undefined, "CLAUDE_CODE_SESSION from settings.json should be stripped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (not throws) on settings.json parse error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, "{ invalid json }");
      const warnLogs = [];
      assert.doesNotThrow(() => {
        buildClaudeCodeEnv(undefined, undefined, (msg) => warnLogs.push(msg), settingsPath);
      });
      assert.ok(warnLogs.some(l => l.includes("settings.json")), "should warn on parse error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// stateDir safety guard
// ---------------------------------------------------------------------------

describe("createLlmClient stateDir guard", () => {
  it("warns when stateDir is '/' (single-char path) and uses default instead", async () => {
    const warnLogs = [];
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      stateDir: "/",
      claudeCodePath: "/nonexistent/claude-stateDir-test",
      logWarn: (msg) => warnLogs.push(msg),
    });
    await llm.completeJson("test", "label");
    assert.ok(
      warnLogs.some(l => l.includes("unsafe stateDir") || l.includes("stateDir")),
      `should warn about unsafe stateDir, got: ${JSON.stringify(warnLogs)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// CLAUDE_CODE_ENV_AUTH_PRIORITY — env wins over settings.json when set to "1"
// ---------------------------------------------------------------------------

describe("buildClaudeCodeEnv CLAUDE_CODE_ENV_AUTH_PRIORITY", () => {
  it("settings.json auth key wins by default (no CLAUDE_CODE_ENV_AUTH_PRIORITY)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "from-settings" } }));

      const savedKey = process.env.ANTHROPIC_API_KEY;
      const savedPriority = process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
      process.env.ANTHROPIC_API_KEY = "from-ambient";
      delete process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
      try {
        const env = buildClaudeCodeEnv(undefined, undefined, undefined, settingsPath);
        assert.equal(env.ANTHROPIC_API_KEY, "from-settings",
          "settings.json should win when CLAUDE_CODE_ENV_AUTH_PRIORITY is unset");
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        if (savedPriority === undefined) delete process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
        else process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY = savedPriority;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env var wins over settings.json when CLAUDE_CODE_ENV_AUTH_PRIORITY=1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "from-settings" } }));

      const savedKey = process.env.ANTHROPIC_API_KEY;
      const savedPriority = process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
      process.env.ANTHROPIC_API_KEY = "from-ambient";
      process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY = "1";
      try {
        const env = buildClaudeCodeEnv(undefined, undefined, undefined, settingsPath);
        assert.equal(env.ANTHROPIC_API_KEY, "from-ambient",
          "ambient env var should win when CLAUDE_CODE_ENV_AUTH_PRIORITY=1");
      } finally {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
        if (savedPriority === undefined) delete process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
        else process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY = savedPriority;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractTextFromSdkMessage — assistant message text extraction
// ---------------------------------------------------------------------------

describe("extractTextFromSdkMessage", () => {
  it("returns null for non-object input", () => {
    assert.equal(extractTextFromSdkMessage(null), null);
    assert.equal(extractTextFromSdkMessage("string"), null);
    assert.equal(extractTextFromSdkMessage(42), null);
  });

  it("returns null when message.message is missing", () => {
    assert.equal(extractTextFromSdkMessage({}), null);
    assert.equal(extractTextFromSdkMessage({ type: "assistant" }), null);
  });

  it("returns null when content is missing", () => {
    assert.equal(extractTextFromSdkMessage({ message: {} }), null);
    assert.equal(extractTextFromSdkMessage({ message: { content: null } }), null);
  });

  it("extracts text from block array content", () => {
    const msg = {
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "1", name: "foo", input: {} },
          { type: "text", text: " world" },
        ],
      },
    };
    assert.equal(extractTextFromSdkMessage(msg), "hello\n world");
  });

  it("returns null when block array has no text blocks", () => {
    const msg = {
      message: {
        content: [
          { type: "tool_use", id: "1", name: "foo", input: {} },
        ],
      },
    };
    assert.equal(extractTextFromSdkMessage(msg), null);
  });

  it("returns plain string content directly", () => {
    const msg = { message: { content: "plain string response" } };
    assert.equal(extractTextFromSdkMessage(msg), "plain string response");
  });

  it("returns null for unknown content types (number, object)", () => {
    assert.equal(extractTextFromSdkMessage({ message: { content: 42 } }), null);
    assert.equal(extractTextFromSdkMessage({ message: { content: { type: "unknown" } } }), null);
  });
});

// ---------------------------------------------------------------------------
// createLlmClient — SDK module not found (cachedSdkError path)
// ---------------------------------------------------------------------------

describe("createLlmClient claude-code SDK not installed", () => {
  it("caches MODULE_NOT_FOUND error and does not retry import on subsequent calls", async () => {
    // Use a deliberately bad claudeCodePath AND verify error message is about SDK or path,
    // confirming permanent failure is cached (second call returns same error without re-throwing).
    const warnLogs = [];
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-haiku-4-5",
      claudeCodePath: "/nonexistent/claude-sdk-cache-test",
      logWarn: (msg) => warnLogs.push(msg),
    });

    const result1 = await llm.completeJson("prompt", "label");
    const err1 = llm.getLastError();
    assert.equal(result1, null, "first call should return null on failure");
    assert.ok(err1, "first call should set lastError");

    const result2 = await llm.completeJson("prompt", "label");
    const err2 = llm.getLastError();
    assert.equal(result2, null, "second call should also return null");
    assert.equal(err1, err2, "error should be identical (cached), not a fresh lookup");
  });
});
