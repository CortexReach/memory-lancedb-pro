import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { resolveOpenClawStateDir, resolveOpenClawConfigPath } = jiti("../src/openclaw-paths.ts");

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

describe("OpenClaw state dir resolution", () => {
  it("defaults to ~/.openclaw when no instance variable is set", () => {
    withEnv({}, () => {
      assert.equal(resolveOpenClawStateDir(), path.join(homedir(), ".openclaw"));
      assert.equal(resolveOpenClawConfigPath(), path.join(homedir(), ".openclaw", "openclaw.json"));
    });
  });

  it("prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME and the home default", () => {
    withEnv({ OPENCLAW_STATE_DIR: "/srv/instance-two", OPENCLAW_HOME: "/srv/legacy-home" }, () => {
      assert.equal(resolveOpenClawStateDir(), "/srv/instance-two");
      assert.equal(resolveOpenClawConfigPath(), path.join("/srv/instance-two", "openclaw.json"));
    });
  });

  it("falls back to OPENCLAW_HOME when only that is set", () => {
    withEnv({ OPENCLAW_HOME: "/srv/legacy-home" }, () => {
      assert.equal(resolveOpenClawStateDir(), "/srv/legacy-home");
    });
  });

  it("uses an explicit OPENCLAW_CONFIG_PATH even when the state dir points elsewhere", () => {
    withEnv({ OPENCLAW_STATE_DIR: "/srv/instance-two", OPENCLAW_CONFIG_PATH: "/etc/openclaw/instance-two.json" }, () => {
      assert.equal(resolveOpenClawConfigPath(), "/etc/openclaw/instance-two.json");
    });
  });

  it("treats blank or whitespace-only variables as unset", () => {
    withEnv({ OPENCLAW_STATE_DIR: "   ", OPENCLAW_HOME: "", OPENCLAW_CONFIG_PATH: " " }, () => {
      assert.equal(resolveOpenClawStateDir(), path.join(homedir(), ".openclaw"));
      assert.equal(resolveOpenClawConfigPath(), path.join(homedir(), ".openclaw", "openclaw.json"));
    });
  });
});
