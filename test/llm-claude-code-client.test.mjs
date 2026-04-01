/**
 * Unit tests for the claude-code LLM client.
 * Skipped if @anthropic-ai/claude-agent-sdk is not installed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

// Check if optional dependency is available
function hasOptionalDep(pkgName) {
  try {
    require.resolve(pkgName);
    return true;
  } catch {
    return false;
  }
}

const skipClaudeCodeTests = !hasOptionalDep("@anthropic-ai/claude-agent-sdk");

const { createLlmClient, buildClaudeCodeEnv } = jiti("../src/llm-client.ts");

// ---------------------------------------------------------------------------
// buildClaudeCodeEnv — env sanitization
// ---------------------------------------------------------------------------

describe("buildClaudeCodeEnv", { skip: skipClaudeCodeTests }, () => {
  it("preserves ANTHROPIC_API_KEY when no explicit key provided", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const env = buildClaudeCodeEnv(undefined);
      assert.equal(env.ANTHROPIC_API_KEY, "ambient-key");
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("replaces ANTHROPIC_API_KEY when explicit key provided", () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const env = buildClaudeCodeEnv("explicit-key");
      assert.equal(env.ANTHROPIC_API_KEY, "explicit-key");
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("always sets CLAUDE_CODE_ENTRYPOINT=sdk-ts", () => {
    const env = buildClaudeCodeEnv();
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  });

  it("strips CLAUDECODE (exact) to prevent nested-session errors", () => {
    const savedClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "should-be-stripped";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
    } finally {
      if (savedClaudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = savedClaudeCode;
    }
  });

  it("strips CLAUDECODE_* prefixed vars", () => {
    const saved = process.env.CLAUDECODE_FOO;
    process.env.CLAUDECODE_FOO = "should-be-stripped";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDECODE_FOO, undefined);
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE_FOO;
      else process.env.CLAUDECODE_FOO = saved;
    }
  });

  it("strips CLAUDE_CODE_SESSION but preserves CLAUDE_CODE_OAUTH_TOKEN", () => {
    const savedSession = process.env.CLAUDE_CODE_SESSION;
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_SESSION = "should-be-stripped";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "should-be-preserved";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDE_CODE_SESSION, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "should-be-preserved");
    } finally {
      if (savedSession === undefined) delete process.env.CLAUDE_CODE_SESSION;
      else process.env.CLAUDE_CODE_SESSION = savedSession;
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  it("strips MCP_SESSION_ID", () => {
    const saved = process.env.MCP_SESSION_ID;
    process.env.MCP_SESSION_ID = "should-be-stripped";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.MCP_SESSION_ID, undefined);
    } finally {
      if (saved === undefined) delete process.env.MCP_SESSION_ID;
      else process.env.MCP_SESSION_ID = saved;
    }
  });

  it("preserves CLAUDE_CODE_GIT_BASH_PATH", () => {
    const saved = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    process.env.CLAUDE_CODE_GIT_BASH_PATH = "/path/to/bash";
    try {
      const env = buildClaudeCodeEnv();
      assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "/path/to/bash");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      else process.env.CLAUDE_CODE_GIT_BASH_PATH = saved;
    }
  });

  it("CLAUDE_CODE_ENV_AUTH_PRIORITY=1 makes env var win over settings.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-client-test-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "from-settings" } }));

    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedPriority = process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
    process.env.ANTHROPIC_API_KEY = "from-ambient";
    process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY = "1";

    try {
      // Temporarily override homedir to use our test settings.json
      const savedHomedir = process.env.HOME;
      process.env.HOME = dir;
      try {
        const env = buildClaudeCodeEnv(undefined);
        // When CLAUDE_CODE_ENV_AUTH_PRIORITY=1, ambient env should win
        assert.equal(env.ANTHROPIC_API_KEY, "from-ambient");
      } finally {
        if (savedHomedir === undefined) delete process.env.HOME;
        else process.env.HOME = savedHomedir;
      }
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedPriority === undefined) delete process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY;
      else process.env.CLAUDE_CODE_ENV_AUTH_PRIORITY = savedPriority;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createLlmClient — claude-code factory instantiation
// ---------------------------------------------------------------------------

describe("createLlmClient claude-code", { skip: skipClaudeCodeTests }, () => {
  it("returns a client with completeJson and getLastError functions", () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-sonnet-4-5",
      claudeCodePath: "/nonexistent/claude-test",
    });
    assert.equal(typeof llm.completeJson, "function");
    assert.equal(typeof llm.getLastError, "function");
  });

  it("returns null and sets lastError when claudeCodePath does not exist", async () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-sonnet-4-5",
      claudeCodePath: "/nonexistent/claude-path-test",
    });
    const result = await llm.completeJson("test", "label");
    assert.equal(result, null);
    const err = llm.getLastError();
    assert.ok(err);
    assert.ok(
      err.includes("not found") || err.includes("claude"),
      `lastError should describe the failure, got: ${err}`,
    );
  });

  it("caches claude path resolution failure — does not retry on subsequent calls", async () => {
    const llm = createLlmClient({
      auth: "claude-code",
      model: "claude-sonnet-4-5",
      claudeCodePath: "/nonexistent/claude-cache-test",
    });
    const result1 = await llm.completeJson("test", "label");
    const err1 = llm.getLastError();
    assert.equal(result1, null);
    assert.ok(err1);

    const result2 = await llm.completeJson("test", "label");
    const err2 = llm.getLastError();
    assert.equal(result2, null);
    assert.equal(err1, err2, "error should be identical (cached), not a fresh lookup");
  });
});
