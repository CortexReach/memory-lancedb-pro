import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

const { resolveReflectionSessionSearchDirs } = jiti("../src/session-recovery.ts");

describe("memory-reflection session recovery search dirs", () => {
  it("includes OpenClaw agent session dirs derived from config and keeps workspace/sessions fallback", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/root/.openclaw/workspace" },
        list: [
          { id: "main" },
          { id: "theia", workspace: "/root/.openclaw/workspace/agents/theia" },
        ],
      },
    };

    const dirs = resolveReflectionSessionSearchDirs({
      context: { sessionEntry: { sessionId: "s-1" } },
      cfg,
      workspaceDir: "/root/.openclaw/workspace",
      currentSessionFile: undefined,
      sourceAgentId: "theia",
    });

    assert.ok(
      dirs.includes(path.join("/root/.openclaw", "agents", "theia", "sessions")),
      "expected theia agent sessions dir to be searched",
    );
    assert.ok(
      dirs.includes(path.join("/root/.openclaw/workspace", "sessions")),
      "expected legacy workspace/sessions fallback to stay enabled",
    );
  });

  it("can derive OpenClaw home from sessionFile layout when workspaceDir is unrelated", () => {
    const dirs = resolveReflectionSessionSearchDirs({
      context: {
        previousSessionEntry: {
          sessionFile: "/root/.openclaw/agents/main/sessions/abc123.jsonl.reset.1730000000",
        },
      },
      cfg: {},
      workspaceDir: "/tmp/custom-workspace",
      currentSessionFile: undefined,
      sourceAgentId: "main",
    });

    assert.ok(
      dirs.includes(path.join("/root/.openclaw", "agents", "main", "sessions")),
      "expected main agent sessions dir from sessionFile-derived home",
    );
  });
});
