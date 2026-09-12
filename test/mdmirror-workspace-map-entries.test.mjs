import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: { "openclaw/plugin-sdk": pluginSdkStubPath },
});
const {
  resolveAgentWorkspaceMap,
  getDefaultDbPath,
  getDefaultWorkspaceDir,
  getDefaultMdMirrorDir,
  resolveOpenClawConfigPath,
} = jiti("../index.ts");

const ENV_KEYS = ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_HOME"];
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("mdMirror agent workspace map", () => {
  it("reads the keyed agents.entries form (OpenClaw 2026.9 canonical config)", () => {
    const api = {
      config: {
        agents: {
          entries: {
            main: { workspace: "/ws/main", name: "Main" },
            research: { workspace: "/ws/research" },
            noWorkspace: { name: "x" },
          },
        },
      },
    };
    assert.deepEqual(resolveAgentWorkspaceMap(api), { main: "/ws/main", research: "/ws/research" });
  });

  it("still reads the legacy agents.list array form", () => {
    const api = { config: { agents: { list: [{ id: "main", workspace: "/ws/main" }, { id: "bad" }] } } };
    assert.deepEqual(resolveAgentWorkspaceMap(api), { main: "/ws/main" });
  });

  it("falls back to the config file named by OPENCLAW_CONFIG_PATH, never another instance's file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ldb-wsmap-"));
    const cfgPath = path.join(dir, "openclaw.json");
    writeFileSync(cfgPath, JSON.stringify({ agents: { entries: { "agent-one": { workspace: "/ws/agent-one" } } } }));
    const map = withEnv({ OPENCLAW_CONFIG_PATH: cfgPath }, () => resolveAgentWorkspaceMap({ config: {} }));
    assert.deepEqual(map, { "agent-one": "/ws/agent-one" });
  });

  it("falls back to <OPENCLAW_STATE_DIR>/openclaw.json when no explicit config path is set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ldb-wsmap-state-"));
    writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "agent-two", workspace: "/ws/agent-two" }] } }));
    withEnv({ OPENCLAW_STATE_DIR: dir }, () => {
      assert.equal(resolveOpenClawConfigPath(), path.join(dir, "openclaw.json"));
      assert.deepEqual(resolveAgentWorkspaceMap({ config: {} }), { "agent-two": "/ws/agent-two" });
    });
  });

  it("roots the default db, workspace and mirror dirs at OPENCLAW_STATE_DIR when set", () => {
    withEnv({ OPENCLAW_STATE_DIR: "/tmp/oc-state" }, () => {
      assert.equal(getDefaultDbPath(), path.join("/tmp/oc-state", "memory", "lancedb-pro"));
      assert.equal(getDefaultWorkspaceDir(), path.join("/tmp/oc-state", "workspace"));
      assert.equal(getDefaultMdMirrorDir(), path.join("/tmp/oc-state", "memory", "md-mirror"));
    });
  });

  it("keeps the home-based defaults when no OpenClaw env is set", () => {
    withEnv({}, () => {
      assert.equal(getDefaultMdMirrorDir(), path.join(homedir(), ".openclaw", "memory", "md-mirror"));
      assert.equal(getDefaultDbPath(), path.join(homedir(), ".openclaw", "memory", "lancedb-pro"));
    });
  });
});
